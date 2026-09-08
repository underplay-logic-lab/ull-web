"""
TRELLIS worker on Modal — 参照画像 1 枚 → 3D Gaussian Splatting → 任意カメラ
グリッドでレンダリングして「角度・構図がバラけた画像セット」を返す。

用途: キャラ LoRA の**学習素材生成器**の「幾何ステージ」。拡散モデルに回転を
幻覚させる（Qwen Multi-Angle LoRA 方式）のをやめ、3D 化してカメラを機械的に
回すことで角度網羅を 100% 保証し、同一性を完全ロックする。仕上げ（画風の
復元 = img2img リスタイル）は別ステージ（既存の modal_angle_worker.py の
Qwen-Image-Edit、または後続の専用ワーカー）が担当する。

────────────────────────────────────────────────────────────────────────────
モデル ＆ 依存のライセンス（CLAUDE.md §5 準拠・商用リリース前提）
────────────────────────────────────────────────────────────────────────────
  ✓ microsoft/TRELLIS-image-large ......... MIT（重み・パイプラインコード）
  ✓ gsplat ............................... Apache-2.0（Gaussian ラスタライザ）
  ✓ spconv .............................. Apache-2.0（sparse structure decode）
  ✗ nvdiffrast / nvdiffrec .............. NVIDIA 非商用 → **使わない**
  ✗ diff-gaussian-rasterization (Inria) . 研究用途限定 → **使わない**
  ✗ diffoctreerast ..................... ライセンス未確認 → radiance_field 経路を
                                          使わないので不要（gaussian のみ生成）
  ✗ TRELLIS.2 (4B) ..................... メッシュ出力・nvdiffrast/nvdiffrec 必須
                                          + CUDA 12.4 前提 → 商用不可・§1 と衝突
  → TRELLIS の run() は formats=["gaussian"] のみ要求し、レンダリングは gsplat で
    自前実装する。これで非商用レンダラをコンテナに一切入れずに済む。

────────────────────────────────────────────────────────────────────────────
PoC で詰める必要がある未確定事項（この雛形は構造と gsplat/カメラ側を確定させ、
TRELLIS 統合部は明示的に TODO とする）
────────────────────────────────────────────────────────────────────────────
  1. TRELLIS のイメージビルド: setup.sh は conda 前提。ここでは pip 直インストール
     + git clone。`spconv-cu126` は cu130/py3.13 で動作確認済み（2026-09-08 B300）。
  2. [解決済] DINOv2 は CPU プリキャッシュ（ensure_trellis_cached）で torch.hub
     取得 → Volume commit。GPU 側は cache ヒットのみ。
  3. TRELLIS の Gaussian 正規化スケール（aabb）。既定 CAMERA_BASE_RADIUS は
     実出力を見て調整する。
  4. SH degree（degree 0 のみか rest ありか）。本実装は degree 0（f_dc）だけ RGB へ
     変換してレンダリングする（学習素材には十分）。
  5. [解決済] attention: DINOv2(fp32)は xformers→fa3 で Blackwell 非対応 →
     XFORMERS_DISABLED=1 で SDPA。dense TRELLIS は ATTN_BACKEND=sdpa。sparse SLat
     transformer は xformers/flash_attn しか無いので SPARSE_ATTN_BACKEND=xformers。
  6. [解決済] TRELLIS の __init__ が open3d / plyfile(GPLv3) / kaolin(mesh) を
     無条件 import → _trellis_patches で optional 化、gaussian 経路のみ通す。

Deploy / run:
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy modal_trellis_worker.py

  modal run modal_trellis_worker.py --image-path ./ref.png
    → ./trellis_out/ に turnaround グリッドの PNG を書き出す。

Env overrides:
  TRELLIS_WORKER_GPU     GPU tier を明示（既定: Blackwell b300 -> b200）
  TRELLIS_REPO           HF repo（既定: microsoft/TRELLIS-image-large）
  TRELLIS_ATTN_BACKEND   "sdpa"（既定・Blackwell 対応） / "naive"（xformers/flash_attn は不可）
  TRELLIS_SPCONV_ALGO    "native"（既定・決定的） / "auto"
  TRELLIS_SS_STEPS       sparse structure サンプリング steps（既定 12）
  TRELLIS_SLAT_STEPS     structured latent サンプリング steps（既定 12）
  TRELLIS_RENDER_SIZE    レンダリング解像度の 1 辺 px（既定 1024）
  TRELLIS_BG             背景色 "white"（既定） / "black" / "gray"
"""

import base64
import gc
import io
import os
import pathlib
import time
from urllib.parse import urlparse

import fastapi
import hmac
import modal

app = modal.App("ull-trellis-worker")

MODELS_DIR = "/models"

# modal_lora_worker.py / modal_angle_worker.py と byte 単位で一致させる canonical
# な HF / torch キャッシュ環境（同じ Volume の同じパス）。
HF_CACHE_DIR = f"{MODELS_DIR}/training/hf_cache"
HF_HUB_CACHE_DIR = f"{HF_CACHE_DIR}/hub"
TORCH_CACHE_DIR = f"{MODELS_DIR}/training/torch_cache"

# TRELLIS のリポジトリ本体はこの Volume 配下にクローンして PYTHONPATH に足す
# （pip パッケージが無いため）。再デプロイをまたいで再利用する。
TRELLIS_SRC_DIR = f"{MODELS_DIR}/src/TRELLIS"
TRELLIS_REPO_URL = "https://github.com/microsoft/TRELLIS.git"

TRELLIS_HF_REPO = os.environ.get("TRELLIS_REPO", "").strip() or "microsoft/TRELLIS-image-large"
# TRELLIS の重みは HF キャッシュ（symlink + blob 間接参照）ではなく **プレーンな
# ディレクトリに実ファイル** で置く。理由: huggingface_hub 1.x の Xet ストレージ
# だと大きい .safetensors がスナップショット symlink から通常 blob として解決できず、
# TRELLIS の `os.path.exists(f"{path}.safetensors")` チェックが False → オフラインで
# hf_hub_download にフォールバックして死ぬ（2026-09-08 実機）。plain local_dir なら
# from_pretrained が is_local=True で実ファイルを直読みする。
TRELLIS_WEIGHTS_DIR = f"{MODELS_DIR}/src/TRELLIS-image-large-weights"


def _env_int(name: str, default: int) -> int:
    try:
        v = os.environ.get(name, "").strip()
        return int(v) if v else int(default)
    except (TypeError, ValueError):
        return int(default)


def _env_str(name: str, default: str) -> str:
    return (os.environ.get(name, "").strip() or default)


# --- GPU tier: CLAUDE.md §1 に揃えて既定 Blackwell 固定（b300 -> b200）--------
_DEFAULT_GPU = ["b300", "b200"]


def _resolve_gpu():
    forced = os.environ.get("TRELLIS_WORKER_GPU", "").strip()
    return forced or list(_DEFAULT_GPU)


GPU_REQUEST = _resolve_gpu()

# サンプリング steps（品質 vs 速度）。TRELLIS 公式既定は 25。速度優先で下げると
# ディテールが落ちる（顔が潰れる）ので既定 25。
SS_STEPS = _env_int("TRELLIS_SS_STEPS", 25)
SLAT_STEPS = _env_int("TRELLIS_SLAT_STEPS", 25)
RENDER_SIZE = _env_int("TRELLIS_RENDER_SIZE", 1024)
# スーパーサンプリング倍率: RENDER_SIZE*SSAA で描いて RENDER_SIZE へ縮小。gsplat
# の warm call は 1ms なので実質無料でエイリアシングと細部が改善する。
RENDER_SSAA = _env_int("TRELLIS_RENDER_SSAA", 2)

# TRELLIS Gaussian の正規化立方体はおおむね [-0.5, 0.5]。カメラ距離の基準半径。
# distance 係数（<1=寄り / 1.0 / >1=引き）を掛けて実半径にする。
CAMERA_BASE_RADIUS = 1.9
CAMERA_VFOV_DEG = 40.0
# TRELLIS 空間では入力画像の正面が -Y 方向。yaw=0 のカメラは +Y にいて背面を写す
# ため、azimuth に 180° 足して az0 = 正面にする（2026-09-08 実出力で確認）。
AZIMUTH_OFFSET_DEG = 180.0

# --- デフォルトのターンアラウンドグリッド（frontend 未接続時 / CLI 用）--------
# azimuth: 0=正面, 90=右真横, 180=真後ろ, 270=左真横。
DEFAULT_AZIMUTHS_DEG = [0, 45, 90, 135, 180, 225, 270, 315]
DEFAULT_ELEVATIONS_DEG = [0.0]
# 1.0=全身寄り / 0.5=バストアップ（顔品質の確認用）。gsplat warm は 1ms なので
# 距離を増やしても実質タダ。
DEFAULT_DISTANCES = [1.0, 0.5]

MAX_VIEWS = 512  # 名目上限（原価の歯止めは timeout / scaledown_window が担う）


vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)


def _hf_cache_env() -> dict:
    return {
        "HF_HOME": HF_CACHE_DIR,
        "HF_HUB_CACHE": HF_HUB_CACHE_DIR,
        "HUGGINGFACE_HUB_CACHE": HF_HUB_CACHE_DIR,
        "TRANSFORMERS_CACHE": HF_HUB_CACHE_DIR,
        "TORCH_HOME": TORCH_CACHE_DIR,
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
        # Xet を無効化（1.x の既定は Xet。plain blob で落とさせて symlink 解決を確実に）。
        "HF_HUB_DISABLE_XET": "1",
        # rembg（TRELLIS preprocess_image の背景除去）の u2net.onnx を Volume へ。
        # 未設定だと GPU 側の初回 preprocess で ~170MB を ~/.u2net へ落とす。
        "U2NET_HOME": f"{MODELS_DIR}/training/u2net_cache",
    }


def _apply_hf_cache_env() -> None:
    os.environ.update(_hf_cache_env())


# ---------------------------------------------------------------------------
# コンテナイメージ（CLAUDE.md §1: CUDA 13.0 devel + Python 3.13 + torch cu130）
# ---------------------------------------------------------------------------
# ⚠️ PoC 1: TRELLIS は pip パッケージが無く、公式 setup.sh は conda 前提。ここでは
#    ランタイム Python 依存を pip 直インストールし、リポジトリ本体は @modal.enter
#    で Volume にクローンして PYTHONPATH に足す。custom CUDA 拡張のうち商用可の
#    ものだけ（spconv）。非商用（nvdiffrast / diff-gaussian-rasterization /
#    diffoctreerast）は入れない — レンダリングは gsplat で自前実装するため不要。
image = (
    modal.Image.from_registry(
        "nvidia/cuda:13.0.0-devel-ubuntu24.04",
        add_python="3.13",
    )
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0", "wget", "build-essential")
    .env(
        {
            "CUDA_HOME": "/usr/local/cuda",
            "PATH": "/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LD_LIBRARY_PATH": "/usr/local/cuda/lib64",
            "TORCH_CUDA_ARCH_LIST": "8.0;9.0;10.0;10.3;12.0;10.0+PTX",
            "CC": "gcc",
            "CXX": "g++",
        }
    )
    .pip_install(
        "torch",
        "torchvision",
        index_url="https://download.pytorch.org/whl/cu130",
        extra_index_url="https://download.pytorch.org/whl/nightly/cu130",
    )
    .pip_install(
        # gsplat: Apache-2.0。pure-Python wheel なので **初回 rasterization 呼び出しで
        # CUDA カーネルを JIT コンパイル**（~30 の .cu、torch cpp_extension.load）。
        # TORCH_EXTENSIONS_DIR は Modal Volume に置くと小ファイル大量書き込みで詰まる
        # ため（2026-09-08 実機で ~40分ハング）、コンテナローカルの /tmp に置く。
        # コールドスタートごとに ~2-3分の再コンパイルコストは PoC では許容。
        "gsplat>=1.4.0",
        # TRELLIS ランタイム依存（非商用の rasterizer 群は除外）
        "numpy<2.0",
        "pillow",
        "imageio",
        "imageio-ffmpeg",
        "tqdm",
        "easydict",
        "opencv-python-headless",
        "scipy",
        "einops",
        "transformers>=4.44.0",
        "safetensors",
        "huggingface_hub>=0.24",
        "hf_transfer",
        "rembg[cpu]",           # 背景除去（TRELLIS preprocess_image が使う）
        "onnxruntime",
        "utils3d @ git+https://github.com/EasternJournalist/utils3d.git@9a4eb15",
        "requests",
        "fastapi[standard]",
    )
    .pip_install(
        # ⚠️ PoC 1: spconv の cu130 wheel は未確認。無ければ cu126 変種で動くか、
        #    ソースビルドが要るかを実機で判定する。まず cu126 を試す。
        "spconv-cu126",
    )
    .run_commands(
        # xformers: TRELLIS の **sparse** attention（SLat transformer）は
        # xformers か flash_attn しか受け付けない（sdpa/naive は非対応）。flash_attn
        # は cu130/py3.13 でビルドできないので xformers 必須。cu130 wheel を試す。
        "pip install xformers --index-url https://download.pytorch.org/whl/cu130 "
        "|| pip install xformers "
        "|| echo '[image] xformers install failed'",
    )
    # attention backend の割り当て（2026-09-08 B300 実機で判明）:
    #   - sparse SLat transformer  → xformers（bf16、Cutlass FMHA が Blackwell 対応）
    #   - dense TRELLIS attention   → sdpa（ATTN_BACKEND=sdpa）
    #   - DINOv2 画像コンディショナ → SDPA（XFORMERS_DISABLED=1。fp32 入力だと
    #     xformers が FlashAttention-3 に落ち sm_100 非対応で NotImplementedError）
    .env(
        {
            **_hf_cache_env(),
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": TRELLIS_SRC_DIR,
            # gsplat / torch 拡張の JIT ビルドキャッシュを永続 Volume へ。
            "TORCH_EXTENSIONS_DIR": "/tmp/torch_ext",  # Volume ではなくローカル（上記注記）
            "MAX_JOBS": "8",  # gsplat JIT ビルドの並列度
            "ATTN_BACKEND": _env_str("TRELLIS_ATTN_BACKEND", "sdpa"),
            "SPARSE_ATTN_BACKEND": "xformers",
            "SPCONV_ALGO": _env_str("TRELLIS_SPCONV_ALGO", "native"),
            "XFORMERS_DISABLED": "1",  # DINOv2 を SDPA 経路にする
        }
    )
)

# CPU プリキャッシュ image。GPU が @modal.enter で必要とするものを **全部 CPU で**
# 先に Volume へ落とす: (1) TRELLIS の HF 重み (2) DINOv2（torch.hub、~1.1GB。
# GPU で落とさせない）(3) TRELLIS リポジトリ本体。torch.hub.load は CPU torch で
# 動くので、軽量 CPU wheel の torch だけ入れる（CUDA 版は不要）。
precache_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "torch",
        "torchvision",
        index_url="https://download.pytorch.org/whl/cpu",
    )
    .pip_install(
        "fastapi[standard]",
        "huggingface_hub>=0.24",
        "hf_transfer",
        "requests",
        "safetensors",
        "numpy<2.0",
        "einops",
        # dinov2 の hubconf が import する可能性のある依存（xformers は optional・
        # native attention にフォールバックするので入れない）
        "omegaconf",
        # rembg u2net を CPU で温めるため（GPU 側の初回 DL を防ぐ）
        "rembg",
        "onnxruntime",
    )
    .env(_hf_cache_env())
)


# ---------------------------------------------------------------------------
# Auth（modal_angle_worker.py / modal_lora_worker.py と同一実装）
# ---------------------------------------------------------------------------
def _authorize(request: fastapi.Request) -> None:
    expected = os.environ.get("MODAL_AUTH_TOKEN")
    if not expected:
        raise fastapi.HTTPException(status_code=500, detail="Server auth is not configured.")
    provided = request.headers.get("x-modal-secret") or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ").strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")


# ---------------------------------------------------------------------------
# 画像 I/O（modal_angle_worker.py と同型）
# ---------------------------------------------------------------------------
_ALLOWED_IMAGE_HOSTS = ("huggingface.co", "supabase.co", "supabase.in", "amazonaws.com")


def _load_ref_image(spec: str):
    from PIL import Image

    if not spec or not isinstance(spec, str):
        raise fastapi.HTTPException(status_code=400, detail="image is required")
    spec = spec.strip()
    if spec.startswith("http://") or spec.startswith("https://"):
        import requests

        host = (urlparse(spec).hostname or "").lower()
        if not any(host == h or host.endswith(f".{h}") for h in _ALLOWED_IMAGE_HOSTS):
            raise fastapi.HTTPException(status_code=400, detail=f"image URL host not allowed: {host}")
        resp = requests.get(spec, timeout=30)
        resp.raise_for_status()
        raw = resp.content
    else:
        if spec.startswith("data:"):
            spec = spec.split(",", 1)[-1]
        try:
            raw = base64.b64decode(spec, validate=False)
        except Exception as exc:  # noqa: BLE001
            raise fastapi.HTTPException(status_code=400, detail=f"image is not valid base64: {exc}")
    try:
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception as exc:  # noqa: BLE001
        raise fastapi.HTTPException(status_code=400, detail=f"could not decode image: {exc}")


def _png_b64(img) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ---------------------------------------------------------------------------
# カメラ: azimuth / elevation / distance グリッド → world2cam + K
# ---------------------------------------------------------------------------
# TRELLIS の Gaussian が生きる座標系に **完全一致** させるため、TRELLIS 自身の
# render_utils と同じ式・同じ utils3d ヘルパーを使う:
#   orig = r * [sin(yaw)cos(pitch), cos(yaw)cos(pitch), sin(pitch)]
#   extr = utils3d.torch.extrinsics_look_at(orig, origin, up=[0,0,1])   # Z-up!
#   intr = utils3d.torch.intrinsics_from_fov_xy(fov, fov)               # 正規化
# yaw=pitch=0 は +Y 軸からの視線（= 入力画像の正面）。utils3d の extrinsics は
# OpenCV 規約の world2cam で、gsplat.rasterization の viewmats と一致する。
def _camera_grid(azimuths_deg, elevations_deg, distances):
    """(extr[4,4] torch, K_norm[3,3] torch, label) のリスト。GPU 上で構築する。"""
    import numpy as np
    import torch
    import utils3d

    fov = torch.deg2rad(torch.tensor(float(CAMERA_VFOV_DEG), device="cuda"))
    K_norm = utils3d.torch.intrinsics_from_fov_xy(fov, fov)  # [3,3] 正規化
    origin = torch.zeros(3, device="cuda")
    up = torch.tensor([0.0, 0.0, 1.0], device="cuda")

    views = []
    for dist in distances:
        r = CAMERA_BASE_RADIUS * float(dist)
        for elev in elevations_deg:
            pitch = np.radians(float(elev))
            for az in azimuths_deg:
                yaw = np.radians(float(az) + AZIMUTH_OFFSET_DEG)
                orig = torch.tensor(
                    [
                        np.sin(yaw) * np.cos(pitch),
                        np.cos(yaw) * np.cos(pitch),
                        np.sin(pitch),
                    ],
                    device="cuda",
                    dtype=torch.float32,
                ) * r
                extr = utils3d.torch.extrinsics_look_at(orig, origin, up)
                label = f"az{int(round(az))}_el{int(round(elev))}_d{dist:g}"
                views.append((extr, K_norm, label))
    return views


# gsplat の JIT ビルド成果物（.so + .o）をコンテナ間で再利用する。ビルド自体は
# 必ず /tmp（ローカル）で行い（Volume だと大量小ファイル書き込みで詰まる）、
# **完成後の数十ファイルだけ** Volume にコピーする（一括コピーは詰まらない）。
GSPLAT_EXT_LOCAL = "/tmp/torch_ext"
GSPLAT_EXT_VOL = f"{MODELS_DIR}/training/gsplat_ext"


def _restore_gsplat_ext() -> bool:
    """Volume の成果物を /tmp へ展開。あれば True（= JIT スキップ見込み）。"""
    import shutil

    v = pathlib.Path(GSPLAT_EXT_VOL)
    if not v.is_dir() or not any(v.iterdir()):
        return False
    try:
        shutil.copytree(v, GSPLAT_EXT_LOCAL, dirs_exist_ok=True)
        print(f"[gsplat] restored prebuilt CUDA ext from Volume -> {GSPLAT_EXT_LOCAL}", flush=True)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[gsplat] ext restore skipped: {exc}", flush=True)
        return False


def _save_gsplat_ext() -> None:
    """初回 JIT 後、/tmp の成果物を Volume へ退避（次コンテナで再利用）。"""
    import shutil

    src = pathlib.Path(GSPLAT_EXT_LOCAL)
    if not src.is_dir():
        return
    try:
        shutil.copytree(src, GSPLAT_EXT_VOL, dirs_exist_ok=True)
        vol.commit()
        print(f"[gsplat] saved built CUDA ext to Volume -> {GSPLAT_EXT_VOL}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[gsplat] ext save skipped: {exc}", flush=True)


def _render_gaussians(gaussian, views, width: int, height: int, bg: str):
    """TRELLIS Gaussian オブジェクトを gsplat で N ビューへラスタライズ →
    PIL.Image のリスト。PLY を経由せず activated tensor を直読み（plyfile 回避）。"""
    import time as _t

    import torch
    from PIL import Image

    dev = "cuda"
    _s = _t.time()
    means = gaussian.get_xyz.detach().to(dev).float()              # [N,3]
    quats = gaussian.get_rotation.detach().to(dev).float()         # [N,4] wxyz 正規化済み
    scales = gaussian.get_scaling.detach().to(dev).float()         # [N,3] 線形
    opacities = gaussian.get_opacity.detach().reshape(-1).to(dev).float()  # [N]
    feats = gaussian.get_features.detach().to(dev).float()         # [N, K, 3]（K=1: DC のみ）
    SH_C0 = 0.28209479177387814
    colors = (SH_C0 * feats[:, 0, :] + 0.5).clamp(0.0, 1.0)        # degree-0 -> RGB [N,3]
    print(
        f"[render] gaussian tensors ready in {_t.time() - _s:.1f}s "
        f"(means {tuple(means.shape)}, quats {tuple(quats.shape)})",
        flush=True,
    )

    bg_rgb = {"white": (1.0, 1.0, 1.0), "black": (0.0, 0.0, 0.0), "gray": (0.5, 0.5, 0.5)}.get(
        bg, (1.0, 1.0, 1.0)
    )
    bg_t = torch.tensor(bg_rgb, dtype=torch.float32, device=dev)  # [3]

    print("[render] importing gsplat (first call JIT-compiles CUDA kernels)...", flush=True)
    _s = _t.time()
    from gsplat import rasterization
    print(f"[render] gsplat imported in {_t.time() - _s:.1f}s", flush=True)

    ssaa = max(1, int(RENDER_SSAA))
    rw, rh = width * ssaa, height * ssaa  # スーパーサンプリング解像度で描く

    images = []
    for _i, (extr, K_norm, _label) in enumerate(views):
        # 正規化 intrinsics → ピクセル K（描画解像度基準）
        K = K_norm.clone().to(dev).float()
        K[0, :] *= rw
        K[1, :] *= rh
        # backgrounds は gsplat のバージョンで shape 規約が揺れるので渡さず、
        # alpha を使って自前で合成（out は premultiplied、alpha は不透過度）。
        out, alpha, _meta = rasterization(
            means=means,
            quats=quats,
            scales=scales,
            opacities=opacities,
            colors=colors,
            viewmats=extr.to(dev).float().unsqueeze(0),  # [1,4,4] world2cam
            Ks=K.unsqueeze(0),
            width=rw,
            height=rh,
            render_mode="RGB",
            rasterize_mode="classic",
        )
        comp = (out[0] + (1.0 - alpha[0]) * bg_t).clamp(0.0, 1.0)  # [rh,rw,3]
        img = Image.fromarray(comp.mul(255.0).byte().cpu().numpy())
        if ssaa > 1:
            img = img.resize((width, height), Image.LANCZOS)  # ダウンサンプル = SSAA
        images.append(img)
        if _i == 0:
            print(
                f"[render] first view rasterized in {_t.time() - _s:.1f}s (incl. JIT), "
                f"{rw}x{rh} -> {width}x{height}",
                flush=True,
            )
    print(f"[render] {len(images)} view(s) rendered", flush=True)
    return images


# ---------------------------------------------------------------------------
# TRELLIS ソースパッチ（clone 後に適用・すべて冪等）
# ---------------------------------------------------------------------------
# TRELLIS の __init__ 連鎖は image-to-3d / gaussian しか使わなくても text-to-3d や
# mesh・radiance_field を無条件 import する。商用不可 / py3.13 非対応 / 未使用の
# 依存（open3d, plyfile=GPLv3）を optional import に緩めて、gaussian 経路だけ通す。
def _trellis_patches(src: "pathlib.Path") -> None:
    def _soft_import(rel_path: str, orig_line: str, why: str) -> None:
        p = src / rel_path
        try:
            txt = p.read_text()
        except Exception as exc:  # noqa: BLE001
            print(f"[patch] {rel_path}: read skipped ({exc})", flush=True)
            return
        marker = "# ULL-soft"
        if orig_line not in txt or f"{marker} <<{orig_line.strip()}>>" in txt:
            return
        names = [n.strip().split(" as ")[-1].strip()
                 for n in orig_line.split("import", 1)[1].split(",")]
        indent = orig_line[: len(orig_line) - len(orig_line.lstrip())]
        block = (
            f"{indent}try:  {marker} <<{orig_line.strip()}>> ({why})\n"
            f"{indent}    {orig_line.strip()}\n"
            f"{indent}except ImportError:\n"
            f"{indent}    {' = '.join(names)} = None\n"
        )
        p.write_text(txt.replace(orig_line + "\n", block, 1))
        print(f"[patch] {rel_path}: softened `{orig_line.strip()}`", flush=True)

    def _replace_once(rel_path: str, old: str, new: str, marker: str) -> None:
        p = src / rel_path
        try:
            txt = p.read_text()
        except Exception as exc:  # noqa: BLE001
            print(f"[patch] {rel_path}: read skipped ({exc})", flush=True)
            return
        if marker in txt or old not in txt:
            return
        p.write_text(txt.replace(old, new, 1))
        print(f"[patch] {rel_path}: replaced block ({marker})", flush=True)

    # text-to-3d パイプライン（open3d 依存・py3.13 wheel 無し・未使用）
    _soft_import(
        "trellis/pipelines/__init__.py",
        "from .trellis_text_to_3d import TrellisTextTo3DPipeline",
        "open3d has no py3.13 wheel; text-to-3d unused",
    )
    # Gaussian の PLY I/O（plyfile=GPLv3・save_ply/load_ply は使わず tensor 直読み）
    _soft_import(
        "trellis/representations/gaussian/gaussian_model.py",
        "from plyfile import PlyData, PlyElement",
        "plyfile is GPLv3; we read gaussian tensors directly",
    )
    # mesh 表現（flexicubes → kaolin 依存。cu130/py3.13 で kaolin wheel が無く、
    # formats=["gaussian"] しか使わないのでメッシュ経路ごと optional に）
    _soft_import(
        "trellis/representations/__init__.py",
        "from .mesh import MeshExtractResult",
        "mesh unused; flexicubes needs kaolin (no cu130/py3.13 wheel)",
    )
    # SLat mesh デコーダも同様に optional（gaussian デコーダと同じパッケージ
    # __init__ にいるので、ここを緩めないと SLatGaussianDecoder も import 不可）
    _soft_import(
        "trellis/models/structured_latent_vae/__init__.py",
        "from .decoder_mesh import SLatMeshDecoder, ElasticSLatMeshDecoder",
        "mesh decoder unused; shares package __init__ with the gaussian decoder",
    )
    # Pipeline.from_pretrained は pipeline.json の全モデルをロードする。**mesh
    # デコーダだけ**（クラスが None 化されている・kaolin 不在）ロード失敗を許容して
    # スキップ。それ以外（flow / gaussian / sparse structure）の失敗は必須なので
    # 従来どおり raise させる。
    _replace_once(
        "trellis/pipelines/base.py",
        "        _models = {}\n"
        "        for k, v in args['models'].items():\n"
        "            try:\n"
        "                _models[k] = models.from_pretrained(f\"{path}/{v}\")\n"
        "            except:\n"
        "                _models[k] = models.from_pretrained(v)\n",
        "        _models = {}\n"
        "        for k, v in args['models'].items():\n"
        "            try:  # ULL: local-only load; only the mesh decoder is optional\n"
        "                _models[k] = models.from_pretrained(f\"{path}/{v}\")\n"
        "            except Exception as _ull_e:\n"
        "                if 'mesh' not in k:\n"
        "                    raise\n"
        "                import warnings as _ull_w\n"
        "                _ull_w.warn(f\"[ULL] skipped optional mesh model {k!r}: {_ull_e!r}\")\n",
        "ULL: local-only load",
    )


# ---------------------------------------------------------------------------
# Stage 1: CPU プリキャッシュ（GPU が @modal.enter で要るものを全部 CPU で温める）
#   (1) TRELLIS の HF 重み  (2) DINOv2（torch.hub, ~1.1GB）  (3) TRELLIS リポジトリ
# ---------------------------------------------------------------------------
@app.function(
    image=precache_image,
    timeout=45 * 60,
    cpu=8,
    memory=16384,
    volumes={MODELS_DIR: vol},
    secrets=[
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
    ],
    scaledown_window=2,
)
def ensure_trellis_cached() -> dict:
    """GPU の @modal.enter が必要とする全アセットを **CPU で** 永続 Volume へ
    プリキャッシュする。GPU 側はこのあとダウンロード 0s（コスト方針: 重い DL を
    Blackwell に絶対やらせない）:
      1. TRELLIS の HF 重み（snapshot_download）
      2. DINOv2 画像コンディショナ（torch.hub, facebookresearch/dinov2, ~1.1GB。
         TRELLIS の _init_image_cond_model が from_pretrained 時に取得する。
         TORCH_HOME を Volume に向けてあるので、ここで 1 度落として commit すれば
         GPU 側は cache ヒットのみ + torch.hub の trusted_list も Volume に残る）
      3. TRELLIS リポジトリ本体（pip パッケージ無し → clone して PYTHONPATH で使う）
         + open3d-free パッチ
    """
    import subprocess

    from huggingface_hub import snapshot_download

    _apply_hf_cache_env()
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] vol.reload skipped: {exc}", flush=True)
    pathlib.Path(HF_HUB_CACHE_DIR).mkdir(parents=True, exist_ok=True)

    token = None
    for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"):
        v = (os.environ.get(k) or "").strip()
        if v and v.lower() not in {"", "replace_me", "changeme", "your_token_here"}:
            token = v
            break

    t0 = time.time()
    # plain local_dir（symlink キャッシュではなく実ファイル）。Xet 由来の
    # 解決不能を避ける。壊れた HF キャッシュが残っていれば掃除。
    import shutil as _sh0

    _broken = pathlib.Path(HF_HUB_CACHE_DIR) / "models--microsoft--TRELLIS-image-large"
    if _broken.exists():
        _sh0.rmtree(_broken, ignore_errors=True)
        print(f"[cache] removed stale HF cache dir: {_broken}", flush=True)
    local_dir = snapshot_download(
        TRELLIS_HF_REPO,
        local_dir=TRELLIS_WEIGHTS_DIR,
        token=token,
    )
    print(f"[cache] TRELLIS weights (plain files) -> {local_dir}", flush=True)

    # TRELLIS リポジトリ本体（pip パッケージが無いため clone して PYTHONPATH で使う）。
    # 毎回まっさらに clone し直す（shallow + submodule で ~20s）。理由: ソースに
    # 冪等でないパッチ（_trellis_patches）を当てるので、既存の作業ツリーに再パッチ
    # すると二重適用で壊れる。pristine から始めれば常に決定的。
    # flexicubes は git submodule なので --recurse-submodules 必須（メッシュ抽出用の
    # Python-only モジュール。無いと trellis.representations.mesh の import で落ちる）。
    import shutil as _shutil

    src = pathlib.Path(TRELLIS_SRC_DIR)
    if src.exists():
        _shutil.rmtree(src, ignore_errors=True)
    src.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "clone", "--depth", "1", "--recurse-submodules",
         TRELLIS_REPO_URL, str(src)],
        check=True,
    )
    _trellis_patches(src)

    # --- (2) DINOv2 を CPU で温める（GPU に落とさせない）--------------------
    # TRELLIS の image_cond_model 名は pipeline.json の args から取る（既定は
    # dinov2_vitl14_reg）。torch.hub.load が $TORCH_HOME/hub にリポジトリコード・
    # trusted_list・checkpoints/*.pth を配置する。すべて Volume 上。
    dino_name = "dinov2_vitl14_reg"
    try:
        import json as _json

        _cfg = _json.loads((pathlib.Path(local_dir) / "pipeline.json").read_text())
        dino_name = (_cfg.get("args", {}) or {}).get("image_cond_model") or dino_name
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] pipeline.json read skipped ({exc}); using {dino_name}", flush=True)
    try:
        import torch

        torch.hub.load("facebookresearch/dinov2", dino_name, pretrained=True, trust_repo=True)
        print(f"[cache] DINOv2 warmed on CPU: {dino_name}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] DINOv2 CPU warm FAILED ({exc}) — GPU side will fetch it", flush=True)

    # --- (2b) rembg u2net を CPU で温める（U2NET_HOME は Volume）------------
    try:
        import rembg

        rembg.new_session("u2net")
        print("[cache] rembg u2net warmed on CPU", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] rembg u2net warm FAILED ({exc}) — GPU side will fetch it", flush=True)

    elapsed = round(time.time() - t0, 1)
    try:
        vol.commit()
        print(f"[cache] vol.commit() — TRELLIS ({elapsed}s) -> {local_dir}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] vol.commit skipped: {exc}", flush=True)

    return {"ok": True, "repo": TRELLIS_HF_REPO, "elapsed_s": elapsed, "local_dir": str(local_dir)}


# ---------------------------------------------------------------------------
# Import プローブ（GPU なし・CPU で import 連鎖を検証する。GPU 課金を出さずに
# TRELLIS / gsplat の import エラーをイテレーションするための足場）
# ---------------------------------------------------------------------------
@app.function(
    image=image,  # 本番 GPU と同じ image（spconv / gsplat / trellis 依存）を CPU 起動
    volumes={MODELS_DIR: vol},
    timeout=10 * 60,
    cpu=4,
    memory=16384,
    scaledown_window=2,
)
def probe_imports() -> dict:
    """CPU で検証できる範囲を全部やる: (1) import 連鎖 (2) gsplat / utils3d
    (3) `TrellisImageTo3DPipeline.from_pretrained()`（重みロード + mesh デコーダの
    スキップ + DINOv2 の torch.hub 配線。`.cuda()` はしない）。
    GPU でしか確認できないのは `.cuda()` / `pipe.run()` / gsplat ラスタライズのみ。"""
    _apply_hf_cache_env()
    os.environ["HF_HUB_OFFLINE"] = "1"  # GPU 側と同条件で from_pretrained を検証
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["ATTN_BACKEND"] = "sdpa"
    os.environ["SPARSE_ATTN_BACKEND"] = "xformers"
    os.environ["XFORMERS_DISABLED"] = "1"
    try:
        vol.reload()
    except Exception:  # noqa: BLE001
        pass
    import sys
    import traceback

    sys.path.insert(0, TRELLIS_SRC_DIR)
    result = {}

    def _step(name, fn):
        try:
            fn()
            result[name] = "OK"
        except Exception as exc:  # noqa: BLE001
            result[name] = f"FAIL: {exc}"
            result[name + "_tb"] = traceback.format_exc()[-1800:]

    def _imports():
        import trellis  # noqa: F401
        from trellis.pipelines import TrellisImageTo3DPipeline  # noqa: F401

    def _gsplat():
        import gsplat
        from gsplat import rasterization  # noqa: F401

        result["gsplat_version"] = gsplat.__version__

    def _utils3d():
        import utils3d  # noqa: F401

    def _from_pretrained():
        import os as _os

        from trellis.pipelines import TrellisImageTo3DPipeline

        _ck = _os.path.join(TRELLIS_WEIGHTS_DIR, "ckpts")
        result["ckpts_listing"] = sorted(_os.listdir(_ck)) if _os.path.isdir(_ck) else "NO ckpts/ DIR"
        pipe = TrellisImageTo3DPipeline.from_pretrained(TRELLIS_WEIGHTS_DIR)
        result["pipe_models"] = sorted(pipe.models.keys())

    _step("import_chain", _imports)
    _step("gsplat", _gsplat)
    _step("utils3d", _utils3d)
    _step("from_pretrained_cpu", _from_pretrained)

    print(f"[probe] {result}", flush=True)
    return result


@app.local_entrypoint()
def probe():
    """modal run modal_trellis_worker.py::probe — CPU で import 連鎖だけ検証。"""
    ensure_trellis_cached.remote()
    r = probe_imports.remote()
    for k, v in r.items():
        print(f"  {k}: {v}")


# ---------------------------------------------------------------------------
# gsplat 単体 GPU プローブ（TRELLIS を経由せず、ダミー Gaussian で rasterization
# を 1 回。JIT コンパイル所要時間と Blackwell 動作を隔離検証する）
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    retries=0,
    timeout=15 * 60,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
def probe_gsplat() -> dict:
    import time as _t

    import torch
    from gsplat import rasterization

    dev = "cuda"
    torch.manual_seed(0)
    n = 50_000
    means = torch.randn(n, 3, device=dev) * 0.3
    quats = torch.randn(n, 4, device=dev)
    quats = quats / quats.norm(dim=-1, keepdim=True)
    scales = torch.rand(n, 3, device=dev) * 0.02 + 0.005
    opacities = torch.rand(n, device=dev)
    colors = torch.rand(n, 3, device=dev)
    viewmat = torch.tensor(
        [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 2.5], [0, 0, 0, 1]],
        dtype=torch.float32, device=dev,
    ).unsqueeze(0)
    K = torch.tensor(
        [[512, 0, 512], [0, 512, 512], [0, 0, 1]], dtype=torch.float32, device=dev
    ).unsqueeze(0)

    t0 = _t.time()
    print("[probe_gsplat] first rasterization (JIT compiles kernels)...", flush=True)
    out, alpha, meta = rasterization(
        means=means, quats=quats, scales=scales, opacities=opacities, colors=colors,
        viewmats=viewmat, Ks=K, width=1024, height=1024, render_mode="RGB",
    )
    torch.cuda.synchronize()
    t_first = _t.time() - t0
    print(f"[probe_gsplat] first call: {t_first:.1f}s, out {tuple(out.shape)}", flush=True)

    t1 = _t.time()
    for _ in range(5):
        rasterization(
            means=means, quats=quats, scales=scales, opacities=opacities, colors=colors,
            viewmats=viewmat, Ks=K, width=1024, height=1024, render_mode="RGB",
        )
    torch.cuda.synchronize()
    t_warm = (_t.time() - t1) / 5

    return {
        "ok": True,
        "first_call_s": round(t_first, 1),
        "warm_call_s": round(t_warm, 3),
        "out_shape": list(out.shape),
        "out_range": [round(float(out.min()), 3), round(float(out.max()), 3)],
    }


@app.local_entrypoint()
def gsplat_probe():
    """modal run modal_trellis_worker.py::gsplat_probe — gsplat 単体を GPU で検証。"""
    r = probe_gsplat.remote()
    for k, v in r.items():
        print(f"  {k}: {v}")


# ---------------------------------------------------------------------------
# Stage 2: GPU 推論（TRELLIS 3D 生成 + gsplat レンダリング）
# ---------------------------------------------------------------------------
# 課金防衛（CLAUDE.md §1）: 30 秒 Keep-Warm 規格 + min_containers=0。Multi-Angle
# Studio と同じ「参照 → 複数構図を続けて生成・リロールする対話型ツール」なので
# フロントの 30 秒カウントダウン（src/lib/gpuWarm.ts）と連動させる。
@app.cls(
    image=image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    retries=0,
    timeout=15 * 60,  # PoC 期間の外部上限（steps 25 + gsplat 初回 JIT の余裕込み）。
    scaledown_window=30,
    min_containers=0,
    secrets=[
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
        # 非同期ジョブ（Supabase 連携）は後続で追加。まずは同期 edit + CLI。
    ],
)
class TrellisWorker:
    @modal.enter()
    def load(self):
        """コンテナ起動時に TRELLIS パイプラインを 1 度だけロードして常駐させる。"""
        import torch

        _apply_hf_cache_env()
        try:
            vol.reload()
        except Exception as exc:  # noqa: BLE001
            print(f"[trellis] vol.reload() skipped: {exc}", flush=True)

        # attention backend の割り当て（image 定義の注記参照）。env が来ていなくても
        # ここで確実にセット。trellis の各 attention __init__ は import 時に読むので
        # `from trellis...` より前に。
        os.environ["ATTN_BACKEND"] = _env_str("TRELLIS_ATTN_BACKEND", "sdpa")
        os.environ["SPARSE_ATTN_BACKEND"] = "xformers"
        os.environ["XFORMERS_DISABLED"] = "1"
        os.environ.setdefault("SPCONV_ALGO", _env_str("TRELLIS_SPCONV_ALGO", "native"))
        # プリキャッシュ済みの前提で HF はキャッシュのみ読む。未認証リクエストの
        # etag 再検証が 401 になり hf_hub_download がキャッシュにフォールバックせず
        # 落ちるのを防ぐ（2026-09-08 GPU 実機で slat_flow_model 等が全滅した原因）。
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"

        try:
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            torch.set_float32_matmul_precision("high")
        except Exception as exc:  # noqa: BLE001
            print(f"[trellis] TF32 setup skipped: {exc}", flush=True)

        # gsplat の JIT 成果物を Volume から復元（あれば初回 rasterization の
        # ~5分コンパイルをスキップ）。無ければ初回レンダ後に保存する。
        self._gsplat_ext_cached = _restore_gsplat_ext()

        t0 = time.time()

        # DINOv2 の torch.hub trusted_list を Volume から引き継げているか不明なので、
        # ここで trust_repo=True で 1 度呼んで trust を確立する。ensure_trellis_cached
        # が CPU で weights/repo を落として commit 済みなら **cache ヒットのみ**（DL
        # ゼロ）。万一 CPU プリキャッシュを飛ばして直接呼ばれた場合の保険でもある。
        try:
            torch.hub.load(
                "facebookresearch/dinov2", "dinov2_vitl14_reg",
                pretrained=True, trust_repo=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[trellis] DINOv2 pre-trust skipped: {exc}", flush=True)

        # ⚠️ PoC 1: PYTHONPATH に TRELLIS_SRC_DIR を通してある前提。ensure_trellis_cached
        #    が clone 済みでなければここで落ちるので、呼び出し側は先に CPU 段を回す。
        from trellis.pipelines import TrellisImageTo3DPipeline

        # HF repo ID ではなく **プレーンな重みディレクトリ** を渡す（ensure_trellis_cached
        # が snapshot_download(local_dir=...) で実ファイルとして配置済み）。TRELLIS の
        # base.py が is_local=True 経路になり ckpts/*.{json,safetensors} を直読み
        # （hf_hub_download / Xet / etag 再検証を一切経由しない）。
        if not (pathlib.Path(TRELLIS_WEIGHTS_DIR) / "pipeline.json").is_file():
            raise RuntimeError(
                f"TRELLIS weights not staged at {TRELLIS_WEIGHTS_DIR} — "
                "run ensure_trellis_cached first"
            )
        print(f"[trellis] loading from: {TRELLIS_WEIGHTS_DIR}", flush=True)
        self.pipe = TrellisImageTo3DPipeline.from_pretrained(TRELLIS_WEIGHTS_DIR)
        self.pipe.cuda()

        self._attn_backend = os.environ.get("ATTN_BACKEND")
        print(
            f"[trellis] pipeline ready: {TRELLIS_HF_REPO} in {time.time() - t0:.1f}s "
            f"(attn={self._attn_backend}, spconv={os.environ.get('SPCONV_ALGO')}, "
            f"ss_steps={SS_STEPS}, slat_steps={SLAT_STEPS})",
            flush=True,
        )

    def _vram_gb(self):
        """実効 VRAM 消費量のみ（分母・％・GPU 名は出さない — CLAUDE.md §2）。"""
        try:
            import torch

            if torch.cuda.is_available():
                free_b, total_b = torch.cuda.mem_get_info()
                return round((total_b - free_b) / (1024**3), 1)
        except Exception:  # noqa: BLE001
            pass
        return None

    def _run_trellis(self, image, seed: int):
        """1 枚の RGBA 画像 → TRELLIS Gaussian オブジェクト（PLY を経由しない）。"""
        # 背景除去 + 正規化（TRELLIS 公式の前処理）
        try:
            image = self.pipe.preprocess_image(image)
        except Exception as exc:  # noqa: BLE001
            print(f"[trellis] preprocess_image skipped ({exc}); using raw image", flush=True)

        outputs = self.pipe.run(
            image,
            seed=int(seed),
            formats=["gaussian"],  # radiance_field / mesh は生成しない（非商用依存回避）
            sparse_structure_sampler_params={"steps": SS_STEPS},
            slat_sampler_params={"steps": SLAT_STEPS},
        )
        return outputs["gaussian"][0]

    @modal.method()
    def run_turnaround(
        self,
        image_spec: str,
        azimuths_deg: list | None = None,
        elevations_deg: list | None = None,
        distances: list | None = None,
        seed: int = 1,
        render_size: int | None = None,
        bg: str | None = None,
    ) -> dict:
        """参照画像 → 3D → カメラグリッドでレンダリング。b64 PNG のリストを返す。"""
        import torch

        azimuths_deg = list(azimuths_deg or DEFAULT_AZIMUTHS_DEG)
        elevations_deg = list(elevations_deg or DEFAULT_ELEVATIONS_DEG)
        distances = list(distances or DEFAULT_DISTANCES)
        size = int(render_size or RENDER_SIZE)
        bg = bg or _env_str("TRELLIS_BG", "white")

        views = _camera_grid(azimuths_deg, elevations_deg, distances)
        if not views:
            raise fastapi.HTTPException(status_code=400, detail="camera grid is empty")
        if len(views) > MAX_VIEWS:
            raise fastapi.HTTPException(
                status_code=400, detail=f"too many views ({len(views)} > {MAX_VIEWS})"
            )

        ref = _load_ref_image(image_spec)
        t0 = time.time()
        try:
            gaussian = self._run_trellis(ref, seed)
            n_splats = int(gaussian.get_xyz.shape[0])
            print(
                f"[trellis] 3D generated in {time.time() - t0:.1f}s "
                f"({n_splats} splats) VRAM={self._vram_gb()}GB",
                flush=True,
            )
            images = _render_gaussians(gaussian, views, size, size, bg)
            # 初回 JIT の成果物を Volume に退避（次コンテナで ~5分スキップ）
            if not self._gsplat_ext_cached:
                _save_gsplat_ext()
                self._gsplat_ext_cached = True
        finally:
            gc.collect()
            try:
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            except Exception:  # noqa: BLE001
                pass

        elapsed = round(time.time() - t0, 2)
        labels = [lbl for *_rest, lbl in views]
        print(f"[trellis] {len(images)} view(s) in {elapsed}s", flush=True)
        return {
            "images": [_png_b64(im) for im in images],
            "labels": labels,
            "count": len(images),
            "elapsed_time": elapsed,
            "seed": int(seed),
            "splats": n_splats,
        }

    @modal.fastapi_endpoint(method="POST")
    def edit(self, item: dict, request: fastapi.Request):
        """【同期】1 リクエストで 3D 生成 + 全ビューをレンダリングして即返す。
        入力: {image: <base64|url>, azimuths_deg?, elevations_deg?, distances?,
               seed?, render_size?, bg?}
        出力: {images: [b64,...], labels: [...], count, elapsed_time}
        """
        _authorize(request)
        image_spec = item.get("image") or item.get("image_b64") or ""
        if not image_spec:
            raise fastapi.HTTPException(status_code=400, detail="image is required")
        return self.run_turnaround.local(
            image_spec,
            azimuths_deg=item.get("azimuths_deg"),
            elevations_deg=item.get("elevations_deg"),
            distances=item.get("distances"),
            seed=int(item.get("seed", 1)),
            render_size=item.get("render_size"),
            bg=item.get("bg"),
        )


# ---------------------------------------------------------------------------
# ローカル一発 CLI
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def main(
    image_path: str,
    seed: int = 1,
    render_size: int = 1024,
    bg: str = "white",
    out_dir: str = "./trellis_out",
):
    """modal run modal_trellis_worker.py --image-path ./ref.png

    デフォルトの 8 方向ターンアラウンド（azimuth 0..315, elevation 0, distance 1.0）
    をレンダリングして out_dir に書き出す。"""
    src = pathlib.Path(image_path).expanduser()
    if not src.is_file():
        raise SystemExit(f"--image-path is not a file: {src}")

    image_b64 = base64.b64encode(src.read_bytes()).decode("ascii")

    ensure_trellis_cached.remote()

    result = TrellisWorker().run_turnaround.remote(
        image_b64,
        seed=seed,
        render_size=render_size,
        bg=bg,
    )

    dst = pathlib.Path(out_dir).expanduser()
    dst.mkdir(parents=True, exist_ok=True)
    for i, (b64, label) in enumerate(zip(result["images"], result["labels"])):
        (dst / f"{i:02d}_{label}.png").write_bytes(base64.b64decode(b64))
    print(
        f"[main] {result['count']} view(s) in {result['elapsed_time']}s "
        f"({result['splats']} splats) -> {dst}",
        flush=True,
    )
