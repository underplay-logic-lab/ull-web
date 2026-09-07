"""
Angle worker on Modal — Qwen-Image-Edit (BF16 full model) single / batch
inference for構図（アングル）編集.

1枚の参照画像と、複数の構図編集プロンプト（instructions 配列）を受け取り、
Qwen-Image-Edit の BF16 フル精度パイプラインで各アングルの編集画像を生成して
返す同期エンドポイント。「1参照画像 → N アングル」を 1 リクエストで捌く。

構成・規約は modal_lora_worker.py / modal_wan_animate_blackwell.py を踏襲:
  - コンテナ標準 (CLAUDE.md §1、改変厳禁): nvidia/cuda:13.0.0-devel +
    Python 3.13 + PyTorch cu130 + Blackwell 優先の GPU フォールバック列。
  - 課金防衛 (CLAUDE.md §1): GPU クラスは 30 秒 Keep-Warm 規格
    (`scaledown_window=30`) + `min_containers=0`。Multi-Angle Studio は
    生成結果を見たユーザーが別アングルの追加生成・リロールを連続で行う
    対話型画像生成ツールで、動画生成系ワーカー（WanAnimate 等）と同じく
    フロントの「30 秒カウントダウン（🔥 火をくべる UX / src/lib/gpuWarm.ts）」
    と連動する。30 秒間 無操作なら Scale-to-Zero（0 台維持・待機課金 0 円）。
  - 重みは既存の永続 Volume (`ull-wan-models`) 上の HF キャッシュに保存。
    LoRA worker と同一の canonical パス (`/models/training/hf_cache`) を使い、
    再デプロイ・別コンテナ間で共有する。

Deploy / run:
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy modal_angle_worker.py
    - POST エンドポイント `edit`（Qwen-Image-Edit 推論）を publish。
    - CPU プリキャッシュ関数 `ensure_qwen_edit_cached` も publish。

  modal run modal_angle_worker.py --image ./ref.png \
      --instructions "Change to profile view" \
      --instructions "Change to low-angle shot"
    - ローカル一発実行。生成画像を ./angle_out/ に書き出す。

Env overrides:
  ANGLE_WORKER_GPU        GPU tier を明示指定（例: "a100-80gb", "b300"）。指定時は
                         最優先。未指定なら Blackwell（b300 -> b200）で固定。
                         ローカル `modal run` で検証コストを抑えたいときだけ
                         `ANGLE_WORKER_GPU=a100-80gb` を明示する（modal_lora_worker
                         の LORA_WORKER_GPU と同じ運用）。
  ANGLE_QWEN_EDIT_REPO    Qwen-Image-Edit の HF repo（既定: Qwen/Qwen-Image-Edit）
  ANGLE_ENABLE_COMPILE    "1" で transformer への torch.compile をオプトイン
                         （既定: 無効。2026-09-06 実機計測で逆効果と判明 —
                          warmup 500s+ / A100 定常も悪化 / VRAM 変化なし）
"""

import base64
import gc
import io
import os
import pathlib
import threading
import time
from urllib.parse import urlparse

import fastapi
import hmac
import modal

app = modal.App("ull-angle-worker")

MODELS_DIR = "/models"

# LoRA worker と byte 単位で一致させる canonical な HF / torch キャッシュ環境。
# 同じ Volume の同じパスを指すので、片方が引いた snapshot はもう片方でもヒット。
HF_CACHE_DIR = f"{MODELS_DIR}/training/hf_cache"
HF_HUB_CACHE_DIR = f"{HF_CACHE_DIR}/hub"
TORCH_CACHE_DIR = f"{MODELS_DIR}/training/torch_cache"

# Qwen-Image-Edit（Diffusers 形式・BF16 フルモデル）。
# multi-image 版 (`Qwen/Qwen-Image-Edit-2509` + QwenImageEditPlusPipeline) が
# 必要なら env で差し替え可能だが、既定は 1 参照画像を前提とする base 版。
QWEN_EDIT_REPO = os.environ.get("ANGLE_QWEN_EDIT_REPO", "").strip() or "Qwen/Qwen-Image-Edit"

# GPU tier は CLAUDE.md §1 / modal_lora_worker.py（LORA_WORKER_GPU）に揃えて
# 既定 Blackwell 固定（b300 -> b200）。`ANGLE_WORKER_GPU` を明示したときだけ
# それを最優先する。
#
# ⚠️ A100 を既定にしてはいけない。2026-09-06 計測: torch 2.14.0+cu130 +
#    diffusers 0.40 + transformers 5.16 の現行スタックで A100(sm_80) の DiT
#    forward が ~6x 退行（2.4s/step、健全時 ~0.4s/step）。attention backend /
#    GEMM / SDPA / RoPE / torch.compile いずれも無関係と実機確認済み。cu130 で
#    選べる torch は 2.14.0 のみでダウングレード不可。B300(sm_100) は影響ほぼ
#    なし（0.47s/step）。以前は MODAL_ENV!="production" で暗黙に a100-80gb へ
#    落ちる分岐があり、素の `modal deploy`（MODAL_ENV 未設定）で degraded な
#    A100 デプロイになっていた → 撤去。ローカル `modal run` で検証コストを
#    抑えたいときは `ANGLE_WORKER_GPU=a100-80gb` を明示する。
# Qwen-Image-Edit の 20B transformer は BF16 で ~40GB、TE（Qwen2.5-VL）+ VAE
# 込みでも A100-80GB に収まる（＝明示 override 時のメモリ的な破綻はない）。
_DEFAULT_GPU = ["b300", "b200"]


def _resolve_angle_worker_gpu():
    """ANGLE_WORKER_GPU の明示があればそれ、なければ Blackwell 固定。"""
    forced = os.environ.get("ANGLE_WORKER_GPU", "").strip()
    if forced:
        return forced
    return list(_DEFAULT_GPU)


GPU_REQUEST = _resolve_angle_worker_gpu()

# instructions 配列の上限は撤廃（構図は 3 軸固定で最大 54、名目値だけ残置）。
# 原価の歯止めは 3 段: (1) run_edit_job の二重ウォッチドッグ（フリーズ検知 /
# 原価割れ損切り、in-process・高速）、(2) @app.cls の timeout=2h（Modal 強制・
# プロセス状態に関わらず必ず発火する外部上限）、(3) scaledown_window=30 +
# min_containers=0（アイドル即 Scale-to-Zero）。
MAX_INSTRUCTIONS = 9999

# 推論パラメータの既定値（payload で上書き可）。
DEFAULT_STEPS = 40
DEFAULT_TRUE_CFG = 4.0
DEFAULT_NEGATIVE_PROMPT = " "

# --- 二重ウォッチドッグ（run_edit_job 内の監視スレッド）--------------------
# (1) フリーズ検知: 1 ステップも進まないまま WATCHDOG_FREEZE_S 経過 → os._exit(1)
# (2) 原価割れ損切り: ジョブ開始から API 由来の max_allowed_time 超過 → os._exit(1)
WATCHDOG_FREEZE_S = int(os.environ.get("ANGLE_WATCHDOG_FREEZE_S", str(15 * 60)))
WATCHDOG_POLL_S = 15

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)


def _hf_cache_env() -> dict:
    """全コンテナ（image .env / CPU プリキャッシュ / GPU 推論）で完全一致させる
    モデル & HF/torch キャッシュ環境。1 変数でもズレると GPU 側が CPU 側の
    staged キャッシュを取りこぼして再ダウンロードする。"""
    return {
        "HF_HOME": HF_CACHE_DIR,
        "HF_HUB_CACHE": HF_HUB_CACHE_DIR,
        "HUGGINGFACE_HUB_CACHE": HF_HUB_CACHE_DIR,
        "TRANSFORMERS_CACHE": HF_HUB_CACHE_DIR,
        "TORCH_HOME": TORCH_CACHE_DIR,
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
    }


def _apply_hf_cache_env() -> None:
    os.environ.update(_hf_cache_env())


# コンテナ標準仕様（CLAUDE.md §1、改変厳禁）:
#   nvidia/cuda:13.0.0-devel-ubuntu24.04 + Python 3.13 + PyTorch cu130。
#   modal_lora_worker.py / modal_wan_animate_blackwell.py と同じ土台。
image = (
    modal.Image.from_registry(
        "nvidia/cuda:13.0.0-devel-ubuntu24.04",
        add_python="3.13",
    )
    .apt_install(
        # libgl1-mesa-glx は Ubuntu 24.04 (noble) で廃止 → libgl1 が後継。
        "git",
        "ffmpeg",
        "libgl1",
        "libglib2.0-0",
        "wget",
    )
    .env(
        {
            "CUDA_HOME": "/usr/local/cuda",
            "PATH": "/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LD_LIBRARY_PATH": "/usr/local/cuda/lib64",
            # 8.0=Ampere(A100) 9.0=Hopper(H100) 10.0/10.3=Blackwell(B200/B300)
            # 12.0=consumer Blackwell。GPU フォールバック列の全 tier を native
            # cubin でカバーし、+PTX で前方互換 PTX も base arch に埋める。
            "TORCH_CUDA_ARCH_LIST": "8.0;9.0;10.0;10.3;12.0;10.0+PTX",
            "CC": "gcc",
            "CXX": "g++",
        }
    )
    .pip_install(
        # CLAUDE.md §1 準拠: cu130 安定チャネルを primary、nightly/cu130 を
        # extra に。2026-09-06 の推論回帰調査で、単に extra_index だけ指定して
        # いた旧構成が古めの RC ビルドを掴んでいた疑いがあり、§1 の指定に揃える。
        "torch",
        "torchvision",
        index_url="https://download.pytorch.org/whl/cu130",
        extra_index_url="https://download.pytorch.org/whl/nightly/cu130",
    )
    .pip_install(
        # QwenImageEditPipeline は diffusers 0.35 系で追加。transformers は
        # Qwen2.5-VL テキストエンコーダに新しめが必要。
        "diffusers>=0.35.1",
        "transformers>=4.52.0",
        "accelerate>=1.2.0",
        "safetensors",
        "sentencepiece",
        "einops",
        "Pillow",
        "ftfy",
        "huggingface_hub>=0.24",
        "hf_transfer",
        "requests",
        # @modal.fastapi_endpoint（QwenImageEditWorker.edit）を持つ image には
        # FastAPI の明示インストールが必須（Modal は自動注入しなくなった）。
        "fastapi[standard]",
    )
    # flash-attn（あれば diffusers が最速の attention backend として使う）。
    # 2026-09-06: イメージ再ビルドで torch/diffusers が最新化された結果、
    # A100 の Qwen-Image-Edit eager 推論が 20s→95s に回帰。diffusers の
    # attention dispatch が flash 系カーネルに乗れず SDPA math 経路に落ちていた
    # のが主因。cu130/py3.13 用の flash-attn prebuilt wheel は無いので
    # --no-build-isolation でソースビルド（失敗しても SDPA の _native_flash で
    # フォールバックできるよう非致命扱い）。MAX_JOBS でビルド並列を絞り OOM 回避。
    .run_commands(
        "pip install packaging ninja psutil",
        "MAX_JOBS=4 pip install flash-attn --no-build-isolation "
        "|| echo '[image] flash-attn build failed — SDPA _native_flash にフォールバック'",
        "python -c \"import flash_attn, sys; print('[image] flash-attn', flash_attn.__version__)\" "
        "|| echo '[image] flash-attn not importable'",
    )
    .env(
        {
            **_hf_cache_env(),
            "PYTHONUNBUFFERED": "1",
            # torch.compile を使う場合（ANGLE_ENABLE_COMPILE=1）の Inductor
            # キャッシュを永続 Volume に置く。eager 運用では未使用。
            "TORCHINDUCTOR_CACHE_DIR": f"{MODELS_DIR}/training/inductor_cache",
        }
    )
)

# CPU プリキャッシュ / ローカルディスパッチ用の軽量 image。
# fastapi: このモジュールは top-level で `import fastapi`（_authorize 等）する。
# どの関数のコンテナも起動時にモジュール全体を import するため、GPU を持たない
# dispatch_image にも fastapi が要る（lora worker の dispatch_image と同じ）。
dispatch_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "fastapi[standard]",
        "huggingface_hub>=0.24",
        "hf_transfer",
        "requests",
    )
    .env(_hf_cache_env())
)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def _authorize(request: fastapi.Request) -> None:
    """全エンドポイント共通の bearer トークン検証（lora worker と同一実装）。"""
    expected = os.environ.get("MODAL_AUTH_TOKEN")
    if not expected:
        raise fastapi.HTTPException(status_code=500, detail="Server auth is not configured.")
    provided = request.headers.get("x-modal-secret") or request.headers.get(
        "authorization", ""
    ).removeprefix("Bearer ").strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")


# ---------------------------------------------------------------------------
# 画像 I/O ヘルパー
# ---------------------------------------------------------------------------
_ALLOWED_IMAGE_HOSTS = ("huggingface.co", "supabase.co", "supabase.in", "amazonaws.com")


def _load_ref_image(spec: str):
    """参照画像を PIL.Image（RGB）で返す。Base64（data URI 可）または https URL。"""
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
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise fastapi.HTTPException(status_code=400, detail=f"could not decode image: {exc}")


def _png_b64(img) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ---------------------------------------------------------------------------
# Supabase 連携（非同期ジョブ更新）— modal_lora_worker.py の同名ヘルパーと同型。
# `supabase-model-downloads` シークレットが SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
# を供給する（GPU クラスにマウント）。すべて best-effort で、生成本体を落とさない。
# ---------------------------------------------------------------------------
_ANGLE_RESULTS_BUCKET = "angle-results"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _supabase_request(method: str, path: str, **kwargs):
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("[angle-job] Supabase env not configured — skipping update", flush=True)
        return None
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    return requests.request(method, f"{supabase_url}{path}", headers=headers, timeout=15, **kwargs)


def _patch_angle_job(job_id: str, fields: dict) -> None:
    if not job_id:
        return
    try:
        _supabase_request(
            "PATCH",
            "/rest/v1/angle_jobs",
            params={"id": f"eq.{job_id}"},
            json={**fields, "updated_at": _now_iso()},
            headers={"Prefer": "return=minimal"},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never propagate
        print(f"[angle-job] failed to patch job {job_id}: {exc}", flush=True)


def _append_angle_result(job_id: str, image_url: str, label: str = "") -> None:
    """1 アングル完了を angle_jobs にアトミックに反映（RPC）。"""
    if not job_id or not image_url:
        return
    try:
        _supabase_request(
            "POST",
            "/rest/v1/rpc/append_angle_result",
            json={"p_job_id": job_id, "p_image_url": image_url, "p_label": label or None},
            headers={"Prefer": "return=minimal"},
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[angle-job] failed to append result for job {job_id}: {exc}", flush=True)


def _refund_credits(user_id: str, amount: int) -> None:
    if not user_id or not amount or amount <= 0:
        return
    try:
        res = _supabase_request(
            "GET", "/rest/v1/profiles", params={"id": f"eq.{user_id}", "select": "credits"}
        )
        if res is None:
            return
        res.raise_for_status()
        rows = res.json()
        current = (rows[0].get("credits") if rows else None) or 0
        _supabase_request(
            "PATCH",
            "/rest/v1/profiles",
            params={"id": f"eq.{user_id}"},
            json={"credits": current + amount},
            headers={"Prefer": "return=minimal"},
        )
        print(f"[angle-job] refunded {amount} credits to {user_id}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[angle-job] failed to refund {amount} credits to {user_id}: {exc}", flush=True)


def _upload_angle_image(user_id: str, job_id: str, index: int, png_bytes: bytes):
    """PNG を angle-results バケット（public）へ upsert し、公開 URL を返す。
    ストレージ不通なら None（呼び出し側で data URI にフォールバック）。"""
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        return None
    obj_path = f"{user_id or 'anon'}/{job_id}/{index:02d}.png"
    try:
        res = requests.post(
            f"{supabase_url}/storage/v1/object/{_ANGLE_RESULTS_BUCKET}/{obj_path}",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "image/png",
                "x-upsert": "true",
            },
            data=png_bytes,
            timeout=60,
        )
        res.raise_for_status()
        return f"{supabase_url}/storage/v1/object/public/{_ANGLE_RESULTS_BUCKET}/{obj_path}"
    except Exception as exc:  # noqa: BLE001
        print(f"[angle-job] image upload failed ({obj_path}): {exc}", flush=True)
        return None


# ---------------------------------------------------------------------------
# Stage 1: CPU プリキャッシュ（B300 を HF ダウンロードで遊ばせない）
# ---------------------------------------------------------------------------
@app.function(
    image=dispatch_image,
    # HF から Qwen-Image-Edit フル repo（~40GB）を Volume へ 1 回だけ引く。
    # hf_transfer でも遅くて 20 分程度。1h を外部上限とする（86400 は禁止 —
    # DL がハングしても最大 1h で Modal が殺してコンテナを回収する）。
    timeout=60 * 60,
    cpu=4,
    memory=8192,
    volumes={MODELS_DIR: vol},
    secrets=[
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
    ],
    # GPU-less の単発プリキャッシュ。30 秒 Keep-Warm 規格の対象外なので即切り。
    scaledown_window=2,
)
def ensure_qwen_edit_cached(repo: str = "") -> dict:
    """Qwen-Image-Edit の全コンポーネントを永続 Volume の HF キャッシュに置く。
    キャッシュヒット時は snapshot_download の再検証だけで ~数秒、ミス時は
    hf_transfer で並列 DL してから vol.commit()。GPU 側はこのあと 0s ロード。"""
    from huggingface_hub import snapshot_download

    _apply_hf_cache_env()
    repo = (repo or "").strip() or QWEN_EDIT_REPO

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
    local_dir = snapshot_download(
        repo,
        cache_dir=HF_HUB_CACHE_DIR,
        token=token,
        # BF16 フル精度のみ。fp8 / GGUF / onnx など他フォーマットは引かない。
        ignore_patterns=["*.gguf", "*fp8*", "*onnx*", "*.pt", "*.ckpt"],
    )
    elapsed = round(time.time() - t0, 1)

    try:
        vol.commit()
        print(f"[cache] vol.commit() — {repo} ({elapsed}s) -> {local_dir}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] vol.commit skipped: {exc}", flush=True)

    return {"ok": True, "repo": repo, "elapsed_s": elapsed, "local_dir": str(local_dir)}


# ---------------------------------------------------------------------------
# Stage 2: GPU 推論
# ---------------------------------------------------------------------------
# 課金防衛（CLAUDE.md §1）: 30 秒 Keep-Warm 規格（scaledown_window=30）+
# min_containers=0。Multi-Angle Studio は単発バッチ（LoRA 学習）ではなく、
# ユーザーが生成結果を見て別アングルを連続で追加生成・リロールする対話型
# 画像生成ツール。WanAnimate 等の動画系ワーカーと同様に、フロントの
# 「30 秒カウントダウン（🔥 火をくべる UX / src/lib/gpuWarm.ts）」と連動させ、
# 連続生成中のコールドスタートを回避する。30 秒間 無操作なら
# Scale-to-Zero（0 台維持・待機課金 0 円）へ移行。min_containers=0 は常駐なしを
# 厳格に維持する。
@app.cls(
    image=image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    # 外部歯止め（Modal 強制）。以前は timeout=86400（24h）+ in-process
    # ウォッチドッグ依存だったが、ウォッチドッグは daemon スレッドなので
    # コンテナが @modal.enter() 中に wedge する / GIL が飢餓する / スレッドが
    # 死ぬと発火せず、24h GPU を焼き続ける（＝「意図せず残る」コンテナの主因）。
    # 構図は 3 軸固定で最大 6×3×3=54、Pro(40 step) の現実的最悪でも Blackwell
    # で ~25 分 + コールドスタート/warmup 余裕。2h を Modal 強制の絶対上限とし、
    # 高速側の歯止めは従来どおり run_edit_job の二重ウォッチドッグが担う。
    timeout=2 * 60 * 60,
    scaledown_window=30,
    min_containers=0,
    secrets=[
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
        # SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — 非同期ジョブが angle_jobs を
        # 直接 PATCH / rpc し、angle-results バケットへ画像を上げるために必要。
        modal.Secret.from_name("supabase-model-downloads"),
    ],
)
class QwenImageEditWorker:
    @modal.enter()
    def load(self):
        """コンテナ起動時に BF16 パイプラインを 1 度だけロードして常駐させる。
        warm な間に来た次リクエストはロード 0s で走る。"""
        import torch

        try:
            from diffusers import QwenImageEditPipeline
        except ImportError as exc:  # noqa: BLE001
            raise RuntimeError(
                "QwenImageEditPipeline unavailable — bump diffusers (>=0.35.1)"
            ) from exc

        _apply_hf_cache_env()
        try:
            vol.reload()
        except Exception as exc:  # noqa: BLE001
            print(f"[angle] vol.reload() skipped: {exc}", flush=True)

        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

        # --- 高速化機構の明示有効化（2026-09-06 の推論回帰対策）--------------
        # イメージ再ビルドで torch/diffusers が最新化された際、既定のままだと
        # attention が SDPA math 経路に落ち、A100 で 20s→95s に悪化していた。
        # ここで flash / mem-efficient SDPA を明示 ON にし、TF32 と cuDNN
        # autotune も有効化する。
        try:
            torch.backends.cuda.enable_flash_sdp(True)
            torch.backends.cuda.enable_mem_efficient_sdp(True)
            torch.backends.cuda.enable_math_sdp(True)  # 最後の砦としては残す
            torch.backends.cudnn.benchmark = True
            torch.set_float32_matmul_precision("high")  # RoPE 等の fp32 matmul を TF32 に
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            # 一部の torch nightly でこれが False に退行すると BF16 GEMM が
            # fp32 accum split-K に落ちて ~2x 遅くなる。明示 True。
            torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = True
            torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = True
        except Exception as exc:  # noqa: BLE001
            print(f"[angle] SDP/TF32 setup skipped: {exc}", flush=True)

        t0 = time.time()
        # torch_dtype=bfloat16 = 「BF16 フルモデル」。量子化・オフロードなし。
        self.pipe = QwenImageEditPipeline.from_pretrained(
            QWEN_EDIT_REPO,
            torch_dtype=torch.bfloat16,
            token=token,
        )
        self.pipe.to("cuda")
        self.pipe.set_progress_bar_config(disable=True)
        # 大きめ入力での VAE デコード OOM を避ける。速度影響はごく小。
        try:
            self.pipe.vae.enable_tiling()
        except Exception:  # noqa: BLE001
            pass

        # --- 複素 RoPE を bf16 実数実装に差し替え（回帰の主因対策）----------
        # diffusers 0.40 の QwenDoubleStreamAttnProcessor2_0 は CUDA 既定で
        # apply_rotary_emb_qwen(use_real=False) を使い、Q/K を毎層
        # bf16→fp32 アップキャスト → view_as_complex → 複素乗算 → bf16 と往復。
        # torch.profiler で mul/copy/to の微小カーネル乱射が全体の ~18%。
        # view_as_complex は bf16 非対応なのでこの fp32 往復は不可避 → 複素を
        # 使わない cos/sin 実数回転（bf16 のまま）に丸ごと置換する。
        # ANGLE_FAST_ROPE=0 で無効化。
        # 既定オフ: 2026-09-06 実機で速度改善は確認できず（回帰の主因は別）。
        # 将来スタックで効く可能性に備えて残置。ANGLE_FAST_ROPE=1 で有効化。
        if os.environ.get("ANGLE_FAST_ROPE", "").strip().lower() in ("1", "true", "yes"):
            try:
                import diffusers.models.transformers.transformer_qwenimage as _qm

                def _fast_apply_rotary_emb_qwen(x, freqs_cis, use_real=False, use_real_unbind_dim=-1):
                    # use_real 経路や tuple freqs はそのまま既存実装へ委譲。
                    if use_real or isinstance(freqs_cis, (tuple, list)):
                        return _qm._orig_apply_rotary_emb_qwen(
                            x, freqs_cis, use_real, use_real_unbind_dim
                        )
                    # x: [B, S, H, D]（bf16）, freqs_cis: complex [S, D/2]
                    cos = freqs_cis.real.to(x.dtype).unsqueeze(1).unsqueeze(0)  # [1,S,1,D/2]
                    sin = freqs_cis.imag.to(x.dtype).unsqueeze(1).unsqueeze(0)
                    x1 = x[..., 0::2]
                    x2 = x[..., 1::2]
                    o1 = x1 * cos - x2 * sin
                    o2 = x1 * sin + x2 * cos
                    return torch.stack((o1, o2), dim=-1).flatten(-2)

                if not hasattr(_qm, "_orig_apply_rotary_emb_qwen"):
                    _qm._orig_apply_rotary_emb_qwen = _qm.apply_rotary_emb_qwen
                _qm.apply_rotary_emb_qwen = _fast_apply_rotary_emb_qwen
                _rpd = getattr(_qm, "ROPE_PER_DEVICE", None)
                if isinstance(_rpd, dict):
                    import functools as _ft

                    for _k in list(_rpd.keys()):
                        _rpd[_k] = _ft.partial(_fast_apply_rotary_emb_qwen, use_real=False)
                self._fast_rope = True
                print("[angle] fast bf16 RoPE patch applied (複素経路を実数化)", flush=True)
            except Exception as exc:  # noqa: BLE001
                self._fast_rope = False
                print(f"[angle] fast RoPE patch skipped: {exc}", flush=True)
        else:
            self._fast_rope = False

        # --- diffusers attention backend を固定 ---------------------------
        # QwenImage は img+txt を連結した系列に attention_mask を渡すため、
        # FLASH（マスク非対応）を強制すると SDPA が math カーネルに落ち、
        # [seq, seq] の巨大スコア行列を fp32 で materialize して激遅になる
        # （2026-09-06 の 20s→95s 回帰の主因）。マスクを扱えて全行列を作らない
        # EFFICIENT / cuDNN を優先する。ANGLE_ATTN_BACKEND で上書き可。
        self._attn_backend = "default(native)"
        _set_backend = getattr(self.pipe.transformer, "set_attention_backend", None)
        _forced = os.environ.get("ANGLE_ATTN_BACKEND", "").strip()
        _order = (
            [_forced]
            if _forced
            else ["_native_cudnn", "flash", "_native_flash", "_native_efficient", "native"]
        )
        if callable(_set_backend):
            for _cand in _order:
                try:
                    _set_backend(_cand)
                    self._attn_backend = _cand
                    break
                except Exception as _be:  # noqa: BLE001
                    print(f"[angle] attention backend '{_cand}' unavailable: {_be}", flush=True)
                    continue
        print(f"[angle] attention backend -> {self._attn_backend}", flush=True)

        # --- 環境ダイアグ（1 回だけ）------------------------------------
        try:
            import diffusers as _dfx
            import transformers as _tfx

            try:
                import flash_attn as _fa

                _fa_ver = _fa.__version__
            except Exception:  # noqa: BLE001
                _fa_ver = "NOT INSTALLED"
            _proc = type(getattr(self.pipe.transformer, "_attn_processors", None) or "").__name__
            print(
                "[angle][diag] "
                f"torch={torch.__version__} diffusers={_dfx.__version__} "
                f"transformers={_tfx.__version__} flash_attn={_fa_ver} | "
                f"sdp flash={torch.backends.cuda.flash_sdp_enabled()} "
                f"mem_eff={torch.backends.cuda.mem_efficient_sdp_enabled()} "
                f"math={torch.backends.cuda.math_sdp_enabled()} | "
                f"cudnn={torch.backends.cudnn.version()} bf16_supported="
                f"{torch.cuda.is_bf16_supported()}",
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[angle][diag] skipped: {exc}", flush=True)

        # --- マイクロベンチ: 生の BF16 GEMM / SDPA が遅いのか（= torch カーネル
        #     退行）、それとも diffusers 側（RoPE / norm / python）なのかを切り分け。
        try:
            _x = torch.randn(4096, 3072, device="cuda", dtype=torch.bfloat16)
            _w = torch.randn(3072, 3072, device="cuda", dtype=torch.bfloat16)
            for _ in range(5):
                torch.nn.functional.linear(_x, _w)
            torch.cuda.synchronize()
            _tb = time.time()
            for _ in range(50):
                _y = torch.nn.functional.linear(_x, _w)
            torch.cuda.synchronize()
            _gemm = (time.time() - _tb) / 50 * 1000
            _q = torch.randn(1, 24, 4096, 128, device="cuda", dtype=torch.bfloat16)
            for _ in range(5):
                torch.nn.functional.scaled_dot_product_attention(_q, _q, _q)
            torch.cuda.synchronize()
            _tb = time.time()
            for _ in range(50):
                _a = torch.nn.functional.scaled_dot_product_attention(_q, _q, _q)
            torch.cuda.synchronize()
            _sdpa = (time.time() - _tb) / 50 * 1000
            del _x, _w, _q, _y, _a
            torch.cuda.empty_cache()
            print(
                f"[angle][bench] bf16 linear(4096x3072x3072)={_gemm:.2f}ms  "
                f"sdpa(1,24,4096,128)={_sdpa:.2f}ms "
                f"(健全な A100 目安: linear ~0.6ms / sdpa ~3ms)",
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[angle][bench] skipped: {exc}", flush=True)

        # torch.compile は既定オフ（このワーカーでは 2026-09-06 実機計測で
        # 逆効果と判明したため）。ANGLE_ENABLE_COMPILE=1 で明示オプトイン。
        #
        # 計測結果（Qwen-Image-Edit BF16 / 40 steps / true_cfg 4.0）:
        #   - mode="reduce-overhead"（CUDA Graphs）は即クラッシュ:
        #     CFG 経路が 1 step で transformer を pos/neg 2 回呼び、CUDA Graphs が
        #     1 回目の出力バッファを 2 回目で上書き →
        #     "accessing tensor output of CUDAGraphs that has been overwritten"。
        #   - Inductor デフォルト mode: コンパイル warmup が B300 で 500s、
        #     A100 で 640-915s（"Torchinductor does not support complex operators"
        #     = Qwen の RoPE 複素演算が eager フォールバック + dynamo guard 負荷）。
        #     定常 2 枚目は B300 で 19.1s→14.9s（-22%）だが、warmup 500s を
        #     回収するには 1 コンテナで ~120 枚生成し続ける必要があり、
        #     scaledown_window=30 では非現実的。A100 では定常も悪化（20s→83s）。
        #   → 差し引き無効化。カーネル融合の恩恵より warmup 負債が大きい。
        if os.environ.get("ANGLE_ENABLE_COMPILE", "").strip().lower() in ("1", "true", "yes"):
            try:
                import torch._dynamo

                torch._dynamo.config.suppress_errors = True
            except Exception:  # noqa: BLE001 — belt-and-suspenders only
                pass
            try:
                self.pipe.transformer = torch.compile(self.pipe.transformer, dynamic=True)
                print(
                    "[angle] torch.compile ENABLED via ANGLE_ENABLE_COMPILE "
                    "(inductor default, dynamic) — 初回 forward で 500s+ の warmup",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[angle] torch.compile skipped: {exc}", flush=True)
        else:
            print("[angle] torch.compile disabled (default — 実機計測で逆効果)", flush=True)

        # ウォッチドッグの Heartbeat 用に per-step コールバックが使えるか判定。
        # 使えない古い diffusers では画像単位の更新にフォールバックする。
        try:
            import inspect

            self._supports_step_cb = (
                "callback_on_step_end" in inspect.signature(self.pipe.__call__).parameters
            )
        except (TypeError, ValueError):
            self._supports_step_cb = False

        self._repo = QWEN_EDIT_REPO
        print(
            f"[angle] pipeline ready: {QWEN_EDIT_REPO} bf16 in {time.time() - t0:.1f}s "
            f"(step-callback={self._supports_step_cb})",
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

    @modal.method()
    def run_edit(
        self,
        image_spec: str,
        instructions: list,
        seed=None,
        num_inference_steps: int = DEFAULT_STEPS,
        true_cfg_scale: float = DEFAULT_TRUE_CFG,
        negative_prompt: str = DEFAULT_NEGATIVE_PROMPT,
    ) -> dict:
        import torch

        if not isinstance(instructions, list) or not instructions:
            raise fastapi.HTTPException(status_code=400, detail="instructions must be a non-empty array")
        instructions = [str(x).strip() for x in instructions if str(x).strip()]
        if not instructions:
            raise fastapi.HTTPException(status_code=400, detail="instructions are all empty")
        if len(instructions) > MAX_INSTRUCTIONS:
            raise fastapi.HTTPException(
                status_code=400,
                detail=f"too many instructions ({len(instructions)} > {MAX_INSTRUCTIONS})",
            )

        steps = max(1, min(int(num_inference_steps or DEFAULT_STEPS), 60))
        cfg = float(true_cfg_scale or DEFAULT_TRUE_CFG)
        base_seed = None if seed is None or seed == "" else int(seed)

        t0 = time.time()

        # 参照画像は 1 回だけデコードして PIL オブジェクトを作り、以降の
        # 全 instruction で同じオブジェクトを使い回す（デコード / RGB 変換の
        # コストは 1 回だけ）。VAE / VL エンコード自体は Diffusers パイプライン
        # の __call__ 内で行われるため呼び出しごとに走るが、その分の入力は
        # 共通で、モデルは常駐済み。
        ref = _load_ref_image(image_spec)

        images_b64 = []
        try:
            for idx, instr in enumerate(instructions):
                generator = None
                if base_seed is not None:
                    # アングルごとに決定論的だが別の乱数列にする。
                    generator = torch.Generator(device="cuda").manual_seed(base_seed + idx)

                # --- フェーズ別プロファイル（回帰調査用）--------------------
                _prof = {"call_start": time.time(), "step0": None, "last_step": None, "nsteps": 0}

                def _prof_cb(*a, **_k):
                    _now = time.time()
                    if _prof["step0"] is None:
                        _prof["step0"] = _now
                    _prof["last_step"] = _now
                    _prof["nsteps"] += 1
                    return a[-1] if a and isinstance(a[-1], dict) else {}

                call_kwargs = dict(
                    image=ref,
                    prompt=instr,
                    negative_prompt=negative_prompt,
                    num_inference_steps=steps,
                    true_cfg_scale=cfg,
                    num_images_per_prompt=1,
                    generator=generator,
                )
                if self._supports_step_cb:
                    call_kwargs["callback_on_step_end"] = _prof_cb

                result = self.pipe(**call_kwargs)
                _call_end = time.time()

                images_b64.append(_png_b64(result.images[0]))

                # 前処理+TE = step0 まで / 拡散ループ = step0→last_step /
                # VAE+後処理 = last_step→call_end
                _s0, _sl, _cs = _prof["step0"], _prof["last_step"], _prof["call_start"]
                if _s0 and _sl and _prof["nsteps"] > 1:
                    _pre = _s0 - _cs
                    _loop = _sl - _s0
                    _post = _call_end - _sl
                    _per = _loop / max(1, _prof["nsteps"] - 1)
                    print(
                        f"[angle][prof] {idx + 1}/{len(instructions)}: "
                        f"pre+TE={_pre:.1f}s  loop={_loop:.1f}s ({_prof['nsteps']} steps, "
                        f"{_per * 1000:.0f}ms/step)  VAE+post={_post:.1f}s  "
                        f"call={_call_end - _cs:.1f}s",
                        flush=True,
                    )
                print(
                    f"[angle] {idx + 1}/{len(instructions)} done "
                    f"({time.time() - t0:.1f}s cum) VRAM={self._vram_gb()}GB",
                    flush=True,
                )
        finally:
            # 推論終了後は VRAM を速やかに整理する（モデル本体は常駐のまま、
            # activation / KV / 中間テンソルだけ解放）。
            del ref
            gc.collect()
            try:
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            except Exception:  # noqa: BLE001
                pass

        elapsed = round(time.time() - t0, 2)
        print(f"[angle] {len(images_b64)} angle(s) in {elapsed}s", flush=True)
        return {
            "images": images_b64,
            "elapsed_time": elapsed,
            "count": len(images_b64),
            "seed": base_seed,
            "steps": steps,
        }

    @modal.method()
    def run_edit_job(self, payload: dict) -> dict:
        """完全非同期ジョブ本体。`angle_generate_dispatch` が .spawn() する。

        1 アングル生成するたびに:
          1. PNG を angle-results バケットへ upsert
          2. append_angle_result(RPC) で angle_jobs.images / completed_angles 更新
        完了時 status=completed、失敗時 status=failed ＋ 未生成分のクレジット返金。
        Next.js のリクエストはとうに終了しているので、進捗の担い手はこの関数だけ。

        構図数の上限なし。原価の歯止めは別スレッドの二重ウォッチドッグ:
          (1) フリーズ検知 — WATCHDOG_FREEZE_S(15分) 進捗ゼロ → os._exit(1)
          (2) 原価割れ損切り — 稼働時間 > max_allowed_time → os._exit(1)
        どちらも angle_jobs を failed にして未生成分を返金してから自爆する。

        payload: { job_id, user_id, credits_cost, image(base64|url),
                   instructions[str], labels[str]?, max_allowed_time?(秒),
                   num_inference_steps?, true_cfg_scale?, negative_prompt?, seed? }
        """
        import torch

        job_id = str(payload.get("job_id") or "")
        user_id = str(payload.get("user_id") or "")
        credits_cost = int(payload.get("credits_cost") or 0)
        image_spec = payload.get("image") or payload.get("image_b64") or ""
        raw_instructions = payload.get("instructions") or []
        labels = payload.get("labels") or []
        steps = max(1, min(int(payload.get("num_inference_steps") or DEFAULT_STEPS), 60))
        cfg = float(payload.get("true_cfg_scale") or DEFAULT_TRUE_CFG)
        negative_prompt = payload.get("negative_prompt") or DEFAULT_NEGATIVE_PROMPT
        seed = payload.get("seed")
        base_seed = None if seed is None or seed == "" else int(seed)

        instructions = [str(x).strip() for x in raw_instructions if str(x).strip()][:MAX_INSTRUCTIONS]
        if not instructions:
            _patch_angle_job(job_id, {"status": "failed", "error_message": "instructions are empty"})
            _refund_credits(user_id, credits_cost)
            return {"ok": False, "error": "empty instructions"}

        t0 = time.time()
        _patch_angle_job(job_id, {"status": "processing", "total_angles": len(instructions)})

        try:
            ref = _load_ref_image(image_spec)
        except Exception as exc:  # noqa: BLE001
            _patch_angle_job(
                job_id, {"status": "failed", "error_message": f"reference image error: {exc}"[:500]}
            )
            _refund_credits(user_id, credits_cost)
            return {"ok": False, "error": str(exc)}

        # --- 許容最大 GPU 稼働時間（API が消費クレジットから算出して渡す）------
        max_allowed_time = None
        try:
            _mat = float(payload.get("max_allowed_time") or 0)
            if _mat > 0:
                max_allowed_time = _mat
        except (TypeError, ValueError):
            max_allowed_time = None

        # --- 二重ウォッチドッグ（別スレッド）--------------------------------
        # (1) フリーズ検知: WATCHDOG_FREEZE_S の間 1 ステップも進まない
        # (2) 原価割れ損切り: ジョブ開始から max_allowed_time 超過
        # どちらも os._exit(1) でコンテナごと強制終了（未生成分は返金）。
        n_total = len(instructions)
        last_progress_time = [time.time()]  # Heartbeat が更新する可変ボックス
        progress_box = {"done": 0}          # 監視スレッドが返金額計算に使う
        watchdog_stop = threading.Event()

        def _self_destruct(reason: str, kind: str) -> None:
            print(f"[angle-job][WATCHDOG] {job_id}: {kind} — {reason} → os._exit(1)", flush=True)
            try:
                _patch_angle_job(job_id, {"status": "failed", "error_message": reason[:500]})
                remaining = n_total - progress_box["done"]
                if remaining > 0 and credits_cost > 0 and n_total > 0:
                    _refund_credits(user_id, int(round(credits_cost * remaining / n_total)))
            except Exception as _e:  # noqa: BLE001
                print(f"[angle-job][WATCHDOG] cleanup failed: {_e}", flush=True)
            os._exit(1)

        def _watchdog() -> None:
            while not watchdog_stop.wait(WATCHDOG_POLL_S):
                now = time.time()
                stalled = now - last_progress_time[0]
                if stalled > WATCHDOG_FREEZE_S:
                    _self_destruct(
                        f"フリーズ検知: {int(stalled)}s の間 1 ステップも進捗なし"
                        f"（>{WATCHDOG_FREEZE_S}s）。GPU デッドロックとみなし強制終了。",
                        "FREEZE",
                    )
                if max_allowed_time is not None and (now - t0) > max_allowed_time:
                    _self_destruct(
                        f"原価割れ検知（損切り）: GPU 稼働 {int(now - t0)}s が"
                        f"許容最大 {int(max_allowed_time)}s を超過。強制終了。",
                        "COST",
                    )

        watchdog = threading.Thread(target=_watchdog, name="angle-watchdog", daemon=True)
        watchdog.start()
        print(
            f"[angle-job] {job_id} watchdog armed: freeze>{WATCHDOG_FREEZE_S}s, "
            f"cost-cap={'off' if max_allowed_time is None else f'{int(max_allowed_time)}s'}, "
            f"angles={n_total}",
            flush=True,
        )

        def _heartbeat(*a, **_k):
            # Diffusers callback_on_step_end: 1 ステップ進むたびに呼ばれる。
            last_progress_time[0] = time.time()
            return a[-1] if a and isinstance(a[-1], dict) else {}

        done = 0
        try:
            for idx, instr in enumerate(instructions):
                # 各アングルの開始で Heartbeat をリセット — フリーズ判定は
                # 「この 1 枚が 15 分まったく進まない」を基準にする。
                last_progress_time[0] = time.time()
                generator = None
                if base_seed is not None:
                    generator = torch.Generator(device="cuda").manual_seed(base_seed + idx)

                call_kwargs = dict(
                    image=ref,
                    prompt=instr,
                    negative_prompt=negative_prompt,
                    num_inference_steps=steps,
                    true_cfg_scale=cfg,
                    num_images_per_prompt=1,
                    generator=generator,
                )
                if self._supports_step_cb:
                    call_kwargs["callback_on_step_end"] = _heartbeat

                result = self.pipe(**call_kwargs)

                buf = io.BytesIO()
                result.images[0].save(buf, format="PNG")
                png = buf.getvalue()

                url = _upload_angle_image(user_id, job_id, idx, png)
                if url is None:
                    # ストレージ不通でもフロントで表示できるよう data URI で返す。
                    url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
                label = str(labels[idx]) if idx < len(labels) else ""
                _append_angle_result(job_id, url, label)
                done += 1
                # 画像単位でも Heartbeat（デコード + アップロードの隙間を埋める）。
                last_progress_time[0] = time.time()
                progress_box["done"] = done
                vram_gb = self._vram_gb()
                # ライブ「Active VRAM」バッジ用（ネタバレ防止 — 分母・％・GPU名なし。
                # フロントは angle_jobs.metadata.vram_used_gb を pollAngleJob で読む）。
                if vram_gb is not None:
                    _patch_angle_job(job_id, {"metadata": {"vram_used_gb": vram_gb}})
                print(
                    f"[angle-job] {job_id} {done}/{n_total} "
                    f"({time.time() - t0:.1f}s cum) VRAM={vram_gb}GB",
                    flush=True,
                )
        except Exception as exc:  # noqa: BLE001
            print(f"[angle-job] {job_id} failed after {done}/{n_total}: {exc}", flush=True)
            _patch_angle_job(job_id, {"status": "failed", "error_message": str(exc)[:500]})
            # 生成できた分だけ課金、残りは返金。
            remaining = n_total - done
            if remaining > 0 and credits_cost > 0:
                _refund_credits(user_id, int(round(credits_cost * remaining / n_total)))
            return {"ok": False, "error": str(exc), "completed": done}
        finally:
            # 監視スレッドを安全に終了（正常完了・例外の両方でここを通る）。
            watchdog_stop.set()
            watchdog.join(timeout=WATCHDOG_POLL_S + 2)
            try:
                del ref
            except Exception:  # noqa: BLE001
                pass
            gc.collect()
            try:
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            except Exception:  # noqa: BLE001
                pass

        elapsed = round(time.time() - t0, 2)
        _patch_angle_job(job_id, {"status": "completed"})
        print(f"[angle-job] {job_id} completed {done} angle(s) in {elapsed}s", flush=True)
        return {"ok": True, "completed": done, "elapsed_time": elapsed}

    @modal.fastapi_endpoint(method="POST")
    def edit(self, item: dict, request: fastapi.Request):
        """【レガシー / 同期】1 リクエストで全アングルを生成して即返す。
        フロントは非同期版（angle_generate_dispatch + angle_jobs ポーリング）へ
        移行済み。`modal run` / デバッグ / 外部小規模利用向けに残置。

        入力:  {image: <base64|url>, instructions: [str, ...], seed?: int,
                num_inference_steps?: int, true_cfg_scale?: float,
                negative_prompt?: str}
        出力:  {images: [base64, ...], elapsed_time: float, count: int}
        """
        _authorize(request)
        image_spec = item.get("image") or item.get("image_b64") or ""
        if not image_spec:
            raise fastapi.HTTPException(status_code=400, detail="image is required")
        # .local() = 同一コンテナ内でメソッド本体を実行（別 GPU コンテナを
        # 立てない）。blackwell の generate → generate_video.local と同じ。
        return self.run_edit.local(
            image_spec,
            item.get("instructions") or [],
            seed=item.get("seed"),
            num_inference_steps=item.get("num_inference_steps", DEFAULT_STEPS),
            true_cfg_scale=item.get("true_cfg_scale", DEFAULT_TRUE_CFG),
            negative_prompt=item.get("negative_prompt", DEFAULT_NEGATIVE_PROMPT),
        )


# ---------------------------------------------------------------------------
# 非同期ディスパッチャ（GPU を持たない warm な軽量関数）
# ---------------------------------------------------------------------------
# blackwell の custom_workflow_async と同じパターン。fastapi_endpoint を GPU
# クラスの *メソッド* にすると .spawn() のためだけに GPU コンテナが立つので、
# ディスパッチは必ず plain @app.function（dispatch_image・GPU なし）に置く。
# scaledown_window=30 で連投時のコールドスタートを避ける（min_containers なし）。
@app.function(
    image=dispatch_image,
    # ACK は sub-second（.spawn() して即返す）。外部上限 5 分で十分。
    timeout=300,
    scaledown_window=30,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def angle_generate_dispatch(item: dict, request: fastapi.Request):
    """POST 非同期ディスパッチ。1 秒以内に ACK し、実生成は .spawn() 側へ委譲。

    入力: { job_id, user_id, credits_cost, image(base64|url), instructions[str],
            labels[str]?, num_inference_steps?, true_cfg_scale?, seed? }
    出力: { ok: true, job_id, call_id }
    """
    _authorize(request)

    job_id = str(item.get("job_id") or "")
    if not job_id:
        raise fastapi.HTTPException(status_code=400, detail="job_id is required")
    instructions = item.get("instructions") or []
    if not isinstance(instructions, list) or not instructions:
        raise fastapi.HTTPException(status_code=400, detail="instructions must be a non-empty array")
    if not (item.get("image") or item.get("image_b64")):
        raise fastapi.HTTPException(status_code=400, detail="image is required")

    call = QwenImageEditWorker().run_edit_job.spawn(item)
    return {"ok": True, "job_id": job_id, "call_id": call.object_id}


# ---------------------------------------------------------------------------
# ローカル一発 CLI
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def main(
    image_path: str,
    instructions: str,
    seed: int = -1,
    steps: int = DEFAULT_STEPS,
    out_dir: str = "./angle_out",
):
    """modal run modal_angle_worker.py --image-path ./ref.png \
           --instructions "Change to profile view || Change to low-angle shot"

    複数プロンプトは ` || ` 区切りで 1 つの --instructions 文字列に入れる
    （Modal の local entrypoint は list 型引数を取れないため）。
    """
    src = pathlib.Path(image_path).expanduser()
    if not src.is_file():
        raise SystemExit(f"--image-path is not a file: {src}")
    instr_list = [s.strip() for s in instructions.split("||") if s.strip()]
    if not instr_list:
        raise SystemExit("pass at least one instruction in --instructions")

    image_b64 = base64.b64encode(src.read_bytes()).decode("ascii")

    # GPU を DL で遊ばせないよう、先に CPU でプリキャッシュしておく。
    ensure_qwen_edit_cached.remote()

    result = QwenImageEditWorker().run_edit.remote(
        image_b64,
        instr_list,
        seed=None if seed is None or seed < 0 else seed,
        num_inference_steps=steps,
    )

    dst = pathlib.Path(out_dir).expanduser()
    dst.mkdir(parents=True, exist_ok=True)
    for i, b64 in enumerate(result["images"]):
        (dst / f"angle_{i:02d}.png").write_bytes(base64.b64decode(b64))
    print(
        f"[main] {result['count']} image(s) in {result['elapsed_time']}s -> {dst}",
        flush=True,
    )
