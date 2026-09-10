"""
SeedVR2 / 超解像スタジオ worker on Modal — 画像・動画を Blackwell フル精度で
アップスケール（refine + 継ぎ目なし 4K/8K）する分離型の有料工程。

用途: ULL Studio の「ローカルでは物理的に無理な仕上げ」。生成は 1〜1.5MP のまま
安く回し、超解像を独立した課金工程にする。B300 の大 VRAM で「フル精度・大タイル・
長尺フレームバッチ」を回すのが差別化点（24GB では不可能）。

得手不得手があるので **商用可アップスケーラーを一通り常駐 → ユーザーが選ぶ** 方式。
このファイルは骨格（モデルレジストリ + ワークフロービルダー + CPU/GPU probe +
`@app.cls`）を確定させ、初回スコープは **SeedVR2 7B 単体**。Real-ESRGAN /
SwinIR-L はレジストリに枠だけ用意し（`enabled=False`）、CPU probe グリーン後に
実重みを足す。

────────────────────────────────────────────────────────────────────────────
モデル ＆ 依存のライセンス（CLAUDE.md §5 準拠・商用リリース前提・確認日 2026-09-09）
────────────────────────────────────────────────────────────────────────────
  ✓ SeedVR2 7B (numz/ComfyUI-SeedVR2_VideoUpscaler / Comfy-Org/SeedVR2)
        ................................ Apache-2.0（重み・推論コード）
        1-step 拡散 DiT・画像＋動画両対応・時間一貫性。AI 生成/アニメ/
        スタイライズの再構成に強い（顔・文字を発明的に作り直す）。
  ✓ SeedVR2 7B sharp .................... Apache-2.0（上記 + くっきり寄り）
  ✓ Real-ESRGAN (x4plus / anime_6B) .... BSD-3-Clause
        すでに綺麗な絵の素直な拡大・破綻しない・爆速。
  ✓ SwinIR-L ........................... Apache-2.0
        実写のノイズ / JPEG 除去つき復元。
  ✗ SUPIR / StableSR ................... S-Lab **非商用** → 採用不可
  ✗ SUPIR 由来の重み・コードを含むノードパックも不可。
  △ VEnhancer / FlashVSR ............... 動画向け・別途ライセンス確認 → 後日

  依存（すべて permissive）:
    ComfyUI (GPLv3 — セルフホストのバックエンドとして許容。配布物には含めない)
    torch/torchvision (BSD) / diffusers (Apache-2.0) / einops (MIT) /
    rotary_embedding_torch (MIT) / SageAttention (Apache-2.0)

────────────────────────────────────────────────────────────────────────────
PoC で詰める未確定事項（この骨格は構造を確定させ、以下は明示的に ⚠️PoC とする）
────────────────────────────────────────────────────────────────────────────
  1. SeedVR2 カスタムノードの正確な repo / class 名 / 入力ソケット名。
     メモ (upscale-studio.md) の記録:
       node `SeedVR2VideoUpscaler`（category `SEEDVR2`）
       params = image / dit(SEEDVR2_DIT) / vae(SEEDVR2_VAE) / seed /
                resolution(短辺目標px) / max_resolution / batch_size(4n+1) /
                color_correction(lab 既定) / offload_device(B300 は "none")
     → CPU probe（probe_imports）で /object_info を実見して確定させる。
  2. SeedVR2 の重みの HF repo / ファイル名。ノードは models/SEEDVR2/ へ自動 DL
     するが、GPU に重い DL をさせない方針（CLAUDE.md §1）なので CPU で先に
     Volume へ置く。repo / filename は UPSCALER_REGISTRY の実データで、404 は
     ensure_upscalers_cached のログで判明する。
  3. 新しい ComfyUI extension API（`from comfy_api.latest import io` /
     `ComfyExtension`）依存 → master を使う（blackwell worker の pin v0.33.3
     では動かない、とメモに記録あり）。SEEDVR2_COMFYUI_REF で固定可能。
  4. batch_size は 4n+1（1,5,9,13,17…）。大きいほど時間一貫性↑＆スループット↑
     だが VRAM 線形増。B300 既定は実測で詰める（骨格は 5）。

────────────────────────────────────────────────────────────────────────────
Deploy / run:
  # CPU プリキャッシュ + CPU import/ノード/ワークフロー probe（GPU 課金なし）
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_seedvr2_worker.py::probe

  # GPU smoke（テスト画像 1 枚・VRAM/時間計測）— CPU probe がグリーンになってから
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_seedvr2_worker.py::gpu_smoke

  # 本番エンドポイント公開
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy modal_seedvr2_worker.py

  # ローカル一発 CLI（GPU 実行）
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_seedvr2_worker.py --image-path ./in.png --model seedvr2_7b

Env overrides:
  SEEDVR2_WORKER_GPU      GPU tier を明示（既定: Blackwell b300 -> b200）
  SEEDVR2_COMFYUI_REF     ComfyUI の git ref（既定: master）
  SEEDVR2_NODE_REPO       SeedVR2 カスタムノードの git URL
  SEEDVR2_ENABLE_MODELS   カンマ区切りで有効モデルを上書き（既定: seedvr2_7b）
  SEEDVR2_BATCH_SIZE      SeedVR2 batch_size（4n+1、既定 5）
  SEEDVR2_TARGET_SHORT    出力の短辺目標 px（既定 1920）
  SEEDVR2_MAX_RESOLUTION  出力の長辺上限 px（既定 4096）
"""

import base64
import hmac
import io
import json
import os
import pathlib
import subprocess
import time
from urllib.parse import urlparse

import fastapi
import modal

app = modal.App("ull-seedvr2-worker")

# ---------------------------------------------------------------------------
# パス / 定数
# ---------------------------------------------------------------------------
COMFY_DIR = "/root/comfy/ComfyUI"
# blackwell worker と同じく Volume を ComfyUI の models/ に直マウントする
# （clone 直後の models/ は空にしておく — 非空パスへの Volume マウントは Modal が
# エラーにする）。diffusion_models/ vae/ loras/ text_encoders/ 等がそのまま
# folder_paths.py の期待どおりの場所に来る。
# f-string（os.path.join だと Windows で "\models" になり、Modal の image
# ビルダーが .env() の値を "unrecognized escape sequence" で弾く）。
MODELS_DIR = f"{COMFY_DIR}/models"
CUSTOM_NODES_SUBDIR = "custom_nodes"
LOGS_SUBDIR = "_logs"
COMFY_PORT = 8188
COMFY_LOG_FILENAME = "seedvr2.log"

# SeedVR2 ノードが重みを探すサブフォルダ（ComfyUI/models/SEEDVR2/）。
SEEDVR2_MODEL_SUBDIR = "SEEDVR2"

# 入力画像の正規化（ull_image_prep）。超解像は「小さい入力を大きくする」用途なので
# 上限は大きめ・下限は付けない（小さいサムネもそのまま拡大対象にする）。倍数は
# ComfyUI 系に合わせて 16。最終解像度はワークフロー側のノードが確定させる。
INPUT_IMG_MAX_EDGE = int(os.environ.get("ULL_INPUT_IMG_MAX_EDGE", "2048"))
INPUT_IMG_MIN_EDGE = int(os.environ.get("ULL_INPUT_IMG_MIN_EDGE", "0"))
INPUT_IMG_MULTIPLE = int(os.environ.get("ULL_INPUT_IMG_MULTIPLE", "16"))

# ダウンロード許可ホスト（管理系と同じ考え方 — 既知の good ホストのみ）。
_ALLOWED_IMAGE_HOSTS = ("huggingface.co", "supabase.co", "supabase.in", "amazonaws.com")


def _env_str(name: str, default: str) -> str:
    return (os.environ.get(name, "").strip() or default)


def _env_int(name: str, default: int) -> int:
    try:
        v = os.environ.get(name, "").strip()
        return int(v) if v else int(default)
    except (TypeError, ValueError):
        return int(default)


# --- GPU tier: CLAUDE.md §1 に揃えて既定 Blackwell 固定（b300 -> b200）--------
_DEFAULT_GPU = ["b300", "b200"]


def _resolve_gpu():
    forced = os.environ.get("SEEDVR2_WORKER_GPU", "").strip()
    return forced or list(_DEFAULT_GPU)


GPU_REQUEST = _resolve_gpu()

COMFYUI_REF = _env_str("SEEDVR2_COMFYUI_REF", "master")
SEEDVR2_NODE_REPO = _env_str(
    "SEEDVR2_NODE_REPO",
    "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git",
)

# 出力寸法の既定（ワークフロービルダーが params で上書きする）。
DEFAULT_TARGET_SHORT = _env_int("SEEDVR2_TARGET_SHORT", 1920)
DEFAULT_MAX_RESOLUTION = _env_int("SEEDVR2_MAX_RESOLUTION", 4096)
DEFAULT_BATCH_SIZE = _env_int("SEEDVR2_BATCH_SIZE", 5)  # 4n+1

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)


# ---------------------------------------------------------------------------
# モデルレジストリ — model_key ごとに「1 行説明・ライセンス・ノード種別・必要な
# 重みファイル・既定パラメータ」を集約。モデル差し替え = ここの config だけ触れば
# 済むようにする（骨格・フロント・課金は無傷、という upscale-studio.md の方針）。
# ---------------------------------------------------------------------------
# model_files: (subdir, filename, hf_repo, hf_filename) のリスト。subdir は
# MODELS_DIR 相対。ensure_upscalers_cached が hf_hub_download で Volume に置く。
UPSCALER_REGISTRY: dict = {
    "seedvr2_7b": {
        "label": "SeedVR2 7B",
        "desc_ja": "AI生成・アニメ向け。顔や文字を作り直す発明的リファイン。画像・動画対応。",
        "license": "Apache-2.0",
        "node_type": "seedvr2",
        "enabled": True,
        "kind": ("image", "video"),
        # ⚠️ PoC 2: repo / filename は要確認。ensure_upscalers_cached のログで 404 が判明する。
        "model_files": [
            (
                SEEDVR2_MODEL_SUBDIR,
                "seedvr2_ema_7b_fp16.safetensors",
                "numz/SeedVR2_comfyUI",
                "seedvr2_ema_7b_fp16.safetensors",
            ),
            (
                SEEDVR2_MODEL_SUBDIR,
                "ema_vae_fp16.safetensors",
                "numz/SeedVR2_comfyUI",
                "ema_vae_fp16.safetensors",
            ),
        ],
        "default_params": {
            "dit": "seedvr2_ema_7b_fp16.safetensors",
            "vae": "ema_vae_fp16.safetensors",
            "target_short": DEFAULT_TARGET_SHORT,
            "max_resolution": DEFAULT_MAX_RESOLUTION,
            "batch_size": DEFAULT_BATCH_SIZE,
            "color_correction": "lab",
            "offload_device": "none",  # B300 は常駐（CLAUDE.md §1: オフロード禁止）
            "seed": 100,
        },
    },
    "seedvr2_7b_sharp": {
        "label": "SeedVR2 7B (sharp)",
        "desc_ja": "SeedVR2 7B をよりくっきり寄りに。線画・エッジを強調したい素材向け。",
        "license": "Apache-2.0",
        "node_type": "seedvr2",
        "enabled": False,  # 初回スコープ外（Volume 逼迫）。sharp 重みを足したら True。
        "kind": ("image", "video"),
        "model_files": [
            (
                SEEDVR2_MODEL_SUBDIR,
                "seedvr2_ema_7b_sharp_fp16.safetensors",
                "numz/SeedVR2_comfyUI",
                "seedvr2_ema_7b_sharp_fp16.safetensors",
            ),
        ],
        "default_params": {
            "dit": "seedvr2_ema_7b_sharp_fp16.safetensors",
            "vae": "ema_vae_fp16.safetensors",
            "target_short": DEFAULT_TARGET_SHORT,
            "max_resolution": DEFAULT_MAX_RESOLUTION,
            "batch_size": DEFAULT_BATCH_SIZE,
            "color_correction": "lab",
            "offload_device": "none",
            "seed": 100,
        },
    },
    "real_esrgan_x4plus": {
        "label": "Real-ESRGAN x4plus",
        "desc_ja": "すでに綺麗な絵の素直な4倍拡大。破綻せず爆速。実写・イラスト汎用。",
        "license": "BSD-3-Clause",
        "node_type": "upscale_model",  # ComfyUI 標準 UpscaleModelLoader + ImageUpscaleWithModel
        "enabled": False,  # ⚠️ PoC: 実重み未配置。CPU probe グリーン後に追加。
        "kind": ("image",),
        "model_files": [
            (
                "upscale_models",
                "RealESRGAN_x4plus.pth",
                "ai-forever/Real-ESRGAN",
                "RealESRGAN_x4plus.pth",
            ),
        ],
        "default_params": {"model_name": "RealESRGAN_x4plus.pth", "scale_by": 4.0},
    },
    "real_esrgan_anime": {
        "label": "Real-ESRGAN anime 6B",
        "desc_ja": "アニメ・イラスト特化の4倍拡大。線をなめらかに保つ。",
        "license": "BSD-3-Clause",
        "node_type": "upscale_model",
        "enabled": False,
        "kind": ("image",),
        "model_files": [
            (
                "upscale_models",
                "RealESRGAN_x4plus_anime_6B.pth",
                "ai-forever/Real-ESRGAN",
                "RealESRGAN_x4plus_anime_6B.pth",
            ),
        ],
        "default_params": {"model_name": "RealESRGAN_x4plus_anime_6B.pth", "scale_by": 4.0},
    },
    "swinir_l": {
        "label": "SwinIR-L",
        "desc_ja": "実写のノイズ・JPEGブロックを除去しながら復元。写真の劣化補正向け。",
        "license": "Apache-2.0",
        "node_type": "upscale_model",  # ⚠️ PoC: SwinIR 用ノードパックが要るか要確認
        "enabled": False,
        "kind": ("image",),
        "model_files": [
            (
                "upscale_models",
                "SwinIR-L_x4_GAN.pth",
                "Comfy-Org/SwinIR",
                "SwinIR-L_x4_GAN.pth",
            ),
        ],
        "default_params": {"model_name": "SwinIR-L_x4_GAN.pth", "scale_by": 4.0},
    },
}


def _enabled_models() -> list:
    override = os.environ.get("SEEDVR2_ENABLE_MODELS", "").strip()
    if override:
        keys = [k.strip() for k in override.split(",") if k.strip()]
        return [k for k in keys if k in UPSCALER_REGISTRY]
    return [k for k, v in UPSCALER_REGISTRY.items() if v.get("enabled")]


def public_registry() -> list:
    """フロント（超解像タブのモデル選択 UI）へ配る、モデル 1 行説明の一覧。
    物理型番・ベンダー名は含めない（CLAUDE.md §2）。"""
    out = []
    enabled = set(_enabled_models())
    for key, v in UPSCALER_REGISTRY.items():
        out.append(
            {
                "key": key,
                "label": v["label"],
                "description": v["desc_ja"],
                "kind": list(v["kind"]),
                "available": key in enabled,
            }
        )
    return out


# ---------------------------------------------------------------------------
# ワークフロービルダー — model_key + params → ComfyUI API 形式のグラフ JSON。
# node_type ごとに分岐。曖昧・未対応は明示的に例外にする（fail-closed）。
# ---------------------------------------------------------------------------
def _build_seedvr2_workflow(reg: dict, params: dict, input_filename: str) -> dict:
    """SeedVR2 の 5 ノードグラフ:
      LoadImage ─┐
      SeedVR2LoadDiTModel ─┤
      SeedVR2LoadVAEModel ─┴→ SeedVR2VideoUpscaler → SaveImage

    ⚠️ dit / vae は **別ローダーノードの出力（SEEDVR2_DIT / SEEDVR2_VAE カスタム型・
    dict）** で、ファイル名文字列を直接 SeedVR2VideoUpscaler.dit に渡すと
    `dit["model"]` で TypeError（2026-09-10 GPU smoke で確認）。
    ノード仕様（numz/ComfyUI-SeedVR2_VideoUpscaler main, 2026-09-10 確認）:
      SeedVR2LoadDiTModel: model(combo: registry名 + models/SEEDVR2 の実ファイル),
        device, blocks_to_swap, swap_io_components, offload_device, cache_model,
        attention_mode(sdpa/flash_attn_2/3/sageattn_2/3), torch_compile_args
        → RETURN SEEDVR2_DIT
      SeedVR2LoadVAEModel: model(STRING), device, encode_tiled/decode_tiled ほか
        → RETURN SEEDVR2_VAE
      SeedVR2VideoUpscaler: image, dit, vae 必須 / seed, resolution(短辺目標),
        max_resolution, batch_size(4n+1), ほか optional
    デフォルトが CLAUDE.md §1 準拠（offload_device="none" / cache_model=False =
    オフロードなし・BF16 常駐）なので、上書きが要る値だけ渡す。
    """
    p = {**reg["default_params"], **(params or {})}
    batch = int(p.get("batch_size", DEFAULT_BATCH_SIZE))
    if batch % 4 != 1:
        batch = max(1, ((batch - 1) // 4) * 4 + 1)  # 直近の 4n+1 に丸める
    short = int(p.get("target_short", DEFAULT_TARGET_SHORT))

    return {
        "load_image": {
            "class_type": "LoadImage",
            "inputs": {"image": input_filename},
            "_meta": {"title": "input"},
        },
        "dit_loader": {
            "class_type": "SeedVR2LoadDiTModel",
            "inputs": {
                "model": p["dit"],              # COMBO: models/SEEDVR2 の実ファイル名
                "device": p.get("device", "cuda:0"),
                # SDPA 明示（SageAttention は image 未導入。導入後に切替検討）。
                "attention_mode": p.get("attention_mode", "sdpa"),
                # CLAUDE.md §1: オフロード禁止（BF16 常駐）。
                "offload_device": "none",
            },
            "_meta": {"title": "DiT"},
        },
        "vae_loader": {
            "class_type": "SeedVR2LoadVAEModel",
            "inputs": {
                "model": p["vae"],
                "device": p.get("device", "cuda:0"),
                "offload_device": "none",
            },
            "_meta": {"title": "VAE"},
        },
        "seedvr2": {
            "class_type": "SeedVR2VideoUpscaler",
            "inputs": {
                "image": ["load_image", 0],
                "dit": ["dit_loader", 0],
                "vae": ["vae_loader", 0],
                "seed": int(p.get("seed", 100)),
                "resolution": short,             # 短辺目標 px
                "max_resolution": int(p.get("max_resolution", DEFAULT_MAX_RESOLUTION)),
                "batch_size": batch,             # 4n+1（静止画は 1）
                "uniform_batch_size": bool(p.get("uniform_batch_size", False)),
                # COMBO: lab / wavelet / wavelet_adaptive / hsv / adain / none
                "color_correction": p.get("color_correction", "lab"),
                # CLAUDE.md §1: オフロード禁止（既定は "cpu" なので明示上書き）。
                "offload_device": "none",
            },
            "_meta": {"title": "SeedVR2 upscale"},
        },
        "save": {
            "class_type": "SaveImage",
            "inputs": {"images": ["seedvr2", 0], "filename_prefix": "ull_upscale"},
            "_meta": {"title": "output"},
        },
    }


def _build_upscale_model_workflow(reg: dict, params: dict, input_filename: str) -> dict:
    """ComfyUI 標準の UpscaleModelLoader + ImageUpscaleWithModel 経路
    （Real-ESRGAN / SwinIR 等の ESRGAN 系 .pth）。"""
    p = {**reg["default_params"], **(params or {})}
    return {
        "load_image": {
            "class_type": "LoadImage",
            "inputs": {"image": input_filename},
            "_meta": {"title": "input"},
        },
        "load_model": {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": p["model_name"]},
            "_meta": {"title": "upscale model"},
        },
        "upscale": {
            "class_type": "ImageUpscaleWithModel",
            "inputs": {"upscale_model": ["load_model", 0], "image": ["load_image", 0]},
            "_meta": {"title": "upscale"},
        },
        "save": {
            "class_type": "SaveImage",
            "inputs": {"images": ["upscale", 0], "filename_prefix": "ull_upscale"},
            "_meta": {"title": "output"},
        },
    }


def build_upscale_workflow(model_key: str, params: dict, input_filename: str) -> dict:
    if model_key not in UPSCALER_REGISTRY:
        raise ValueError(f"unknown model_key: {model_key!r}")
    reg = UPSCALER_REGISTRY[model_key]
    node_type = reg["node_type"]
    if node_type == "seedvr2":
        return _build_seedvr2_workflow(reg, params, input_filename)
    if node_type == "upscale_model":
        return _build_upscale_model_workflow(reg, params, input_filename)
    raise ValueError(f"unsupported node_type {node_type!r} for {model_key!r}")


# ---------------------------------------------------------------------------
# HF / torch キャッシュ環境 — trellis / lora / angle worker と byte 単位で一致
# させる（同じ Volume の同じパス）。
# ---------------------------------------------------------------------------
HF_CACHE_DIR = f"{MODELS_DIR}/training/hf_cache"
HF_HUB_CACHE_DIR = f"{HF_CACHE_DIR}/hub"
TORCH_CACHE_DIR = f"{MODELS_DIR}/training/torch_cache"


def _hf_cache_env() -> dict:
    return {
        "HF_HOME": HF_CACHE_DIR,
        "HF_HUB_CACHE": HF_HUB_CACHE_DIR,
        "HUGGINGFACE_HUB_CACHE": HF_HUB_CACHE_DIR,
        "TRANSFORMERS_CACHE": HF_HUB_CACHE_DIR,
        "TORCH_HOME": TORCH_CACHE_DIR,
        "HF_HUB_ENABLE_HF_TRANSFER": "1",
        "HF_HUB_DISABLE_XET": "1",
    }


def _apply_hf_cache_env() -> None:
    os.environ.update(_hf_cache_env())


# ---------------------------------------------------------------------------
# コンテナイメージ（CLAUDE.md §1: CUDA 13.0 devel + Python 3.13 + torch cu130）
# ---------------------------------------------------------------------------
image = (
    modal.Image.from_registry(
        "nvidia/cuda:13.0.0-devel-ubuntu24.04",
        add_python="3.13",
    )
    .apt_install(
        "git", "ffmpeg", "libgl1", "libglib2.0-0", "wget",
        "build-essential", "ninja-build",
    )
    .env(
        {
            "CUDA_HOME": "/usr/local/cuda",
            "PATH": "/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LD_LIBRARY_PATH": "/usr/local/cuda/lib64",
            # 10.0/10.3 = Blackwell / Blackwell Ultra、12.0 = consumer Blackwell。
            "TORCH_CUDA_ARCH_LIST": "10.0;10.3;12.0;10.0+PTX",
            "FLASH_ATTN_CUDA_ARCHS": "100;120",
            "MAX_JOBS": "4",
            # add_python の py3.13 は clang ビルドなので sysconfig が CC=clang を
            # 焼き込む。build-essential の gcc/g++ に矯正しないと SageAttention の
            # ビルドが "clang++ (0.0.0)" で落ちる（blackwell worker と同じ回避）。
            "CC": "gcc",
            "CXX": "g++",
        }
    )
    .pip_install(
        "torch",
        "torchvision",
        "torchaudio",
        index_url="https://download.pytorch.org/whl/cu130",
        extra_index_url="https://download.pytorch.org/whl/nightly/cu130",
    )
    .pip_install("packaging", "wheel", "ninja", "triton")
    # SageAttention を Blackwell 向けに from-source（sm_103 パッチ適用）。
    # blackwell worker と同じ patch スクリプトを流用する。
    .add_local_file(
        # 前方スラッシュに正規化（Windows の \p 等を Modal のビルダーが
        # "unrecognized escape sequence" で弾くのを防ぐ）。
        os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "scripts",
            "patch_sageattention_blackwell_ultra.py",
        ).replace(os.sep, "/"),
        "/root/patch_sageattention_blackwell_ultra.py",
        copy=True,
    )
    .run_commands(
        "git clone https://github.com/thu-ml/SageAttention.git /opt/SageAttention",
        "python3 /root/patch_sageattention_blackwell_ultra.py /opt/SageAttention",
        "pip install --no-build-isolation /opt/SageAttention "
        "|| echo '[image] SageAttention build failed — SDPA fallback'",
    )
    .pip_install(
        "comfy-cli", "websockets", "requests", "aiohttp", "fastapi[standard]",
        "huggingface_hub", "hf_transfer",
    )
    .run_commands(
        f"git clone https://github.com/comfyanonymous/ComfyUI.git {COMFY_DIR}",
        # ⚠️ PoC 3: master 必須（SeedVR2 は新しい comfy_api.latest 依存。pin
        # v0.33.3 では動かない、と upscale-studio.md に記録）。SEEDVR2_COMFYUI_REF
        # で固定可能。
        f"cd {COMFY_DIR} && git fetch --tags --force && git checkout {COMFYUI_REF}",
        f"cd {COMFY_DIR} && pip install -r requirements.txt",
        # SeedVR2 カスタムノード + その requirements。
        f"git clone {SEEDVR2_NODE_REPO} {COMFY_DIR}/custom_nodes/ComfyUI-SeedVR2",
        f"pip install -r {COMFY_DIR}/custom_nodes/ComfyUI-SeedVR2/requirements.txt "
        f"|| echo '[image] SeedVR2 node requirements install had issues'",
        # SeedVR2 node の依存で requirements.txt に無いことがあるもの（メモの記録）。
        "pip install rotary_embedding_torch omegaconf einops 'diffusers>=0.33.1' "
        "'peft>=0.17' opencv-python-headless gguf",
        # ComfyUI-Manager（管理者が UI からノードを足せるように）。
        f"git clone https://github.com/Comfy-Org/ComfyUI-Manager.git"
        f" {COMFY_DIR}/custom_nodes/ComfyUI-Manager",
        f"pip install -r {COMFY_DIR}/custom_nodes/ComfyUI-Manager/requirements.txt",
        # models/ を空にする（Volume マウント先を空にしておく — blackwell worker 参照）。
        f"rm -rf {COMFY_DIR}/models",
    )
    # 全ワーカー共通の入力画像正規化レイヤー。HEIC/AVIF プラグイン付き。
    .pip_install("pillow-heif", "pillow-avif-plugin")
    .env(
        {
            **_hf_cache_env(),
            "PYTHONUNBUFFERED": "1",
        }
    )
    .add_local_python_source("ull_image_prep")
)

# CPU プリキャッシュ用の軽量 image（重い DL を GPU にやらせない — CLAUDE.md §1）。
precache_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "huggingface_hub>=0.24", "hf_transfer", "requests", "safetensors",
        "fastapi[standard]",
    )
    .env(_hf_cache_env())
)

# 非同期ディスパッチ endpoint 用（GPU なし・.spawn() して即 ACK するだけ）。
# _authorize（hmac）と .spawn() しか要らないので最小構成。
dispatch_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastapi[standard]", "requests")
)


# ---------------------------------------------------------------------------
# Auth（他ワーカーと同一実装 — 共有シークレット wan-animate-auth）
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
# 画像 I/O（angle / trellis worker と同型）
# ---------------------------------------------------------------------------
def _load_input_bytes(spec: str) -> bytes:
    if not spec or not isinstance(spec, str):
        raise fastapi.HTTPException(status_code=400, detail="image is required")
    spec = spec.strip()
    if spec.startswith("http://") or spec.startswith("https://"):
        import requests

        host = (urlparse(spec).hostname or "").lower()
        if not any(host == h or host.endswith(f".{h}") for h in _ALLOWED_IMAGE_HOSTS):
            raise fastapi.HTTPException(status_code=400, detail=f"image URL host not allowed: {host}")
        resp = requests.get(spec, timeout=60)
        resp.raise_for_status()
        return resp.content
    if spec.startswith("data:"):
        spec = spec.split(",", 1)[-1]
    try:
        return base64.b64decode(spec, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise fastapi.HTTPException(status_code=400, detail=f"image is not valid base64: {exc}")


def _vram_gb():
    """実効 VRAM 消費量のみ（分母・％・GPU 名は出さない — CLAUDE.md §2）。
    キー名は Studio 共通の vram_used_gb（studio-vram-badge.md）。

    ComfyUI は別プロセスだが mem_get_info はデバイス全体（全プロセス）の
    free/total を返すので、サブプロセスの消費もここに乗る。"""
    try:
        import torch

        if torch.cuda.is_available():
            free_b, total_b = torch.cuda.mem_get_info()
            return round((total_b - free_b) / (1024**3), 1)
    except Exception:  # noqa: BLE001
        pass
    return None


class _VramPeak:
    """with ブロック中、デバイス VRAM 消費を ~0.5s 間隔でサンプリングしてピークを持つ。
    ComfyUI サブプロセスの推論中ピークを worker 側から観測するため（point-in-time の
    _vram_gb() では谷を踏むため）。"""

    def __init__(self, interval: float = 0.5):
        self.interval = interval
        self.peak = _vram_gb()
        self._stop = None
        self._thr = None

    def __enter__(self):
        import threading

        self._stop = threading.Event()

        def _loop():
            while not self._stop.wait(self.interval):
                v = _vram_gb()
                if v is not None and (self.peak is None or v > self.peak):
                    self.peak = v

        self._thr = threading.Thread(target=_loop, daemon=True)
        self._thr.start()
        return self

    def __exit__(self, *_exc):
        if self._stop:
            self._stop.set()
        if self._thr:
            self._thr.join(timeout=2)
        return False


# ---------------------------------------------------------------------------
# Supabase 連携（非同期ジョブ更新）— modal_angle_worker.py の同名ヘルパーと同型。
# `supabase-model-downloads` シークレットが SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
# を供給する（GPU クラスにマウント）。すべて best-effort で、アップスケール本体を
# 落とさない。
# ---------------------------------------------------------------------------
_UPSCALE_RESULTS_BUCKET = "upscale-results"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _supabase_request(method: str, path: str, **kwargs):
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("[upscale-job] Supabase env not configured — skipping update", flush=True)
        return None
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    return requests.request(method, f"{supabase_url}{path}", headers=headers, timeout=15, **kwargs)


def _patch_upscale_job(job_id: str, fields: dict) -> None:
    if not job_id:
        return
    try:
        _supabase_request(
            "PATCH",
            "/rest/v1/upscale_jobs",
            params={"id": f"eq.{job_id}"},
            json={**fields, "updated_at": _now_iso()},
            headers={"Prefer": "return=minimal"},
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        print(f"[upscale-job] failed to patch job {job_id}: {exc}", flush=True)


def _merge_upscale_metadata(job_id: str, extra: dict) -> None:
    """metadata は jsonb。周期 PATCH で既存キーを潰さないよう GET→merge→PATCH。"""
    if not job_id:
        return
    try:
        res = _supabase_request(
            "GET",
            "/rest/v1/upscale_jobs",
            params={"id": f"eq.{job_id}", "select": "metadata"},
        )
        current = {}
        if res is not None and res.ok:
            rows = res.json()
            if rows and isinstance(rows[0].get("metadata"), dict):
                current = rows[0]["metadata"]
        _patch_upscale_job(job_id, {"metadata": {**current, **extra}})
    except Exception as exc:  # noqa: BLE001
        print(f"[upscale-job] metadata merge failed {job_id}: {exc}", flush=True)


def _get_upscale_job_status(job_id: str):
    """upscale_jobs.status を 1 発 GET。取得不能なら None（判定不能＝続行）。
    Modal のクラッシュ由来リトライを冒頭で弾く idempotency ガード用。"""
    if not job_id:
        return None
    try:
        res = _supabase_request(
            "GET",
            "/rest/v1/upscale_jobs",
            params={"id": f"eq.{job_id}", "select": "status,credits_cost,user_id"},
        )
        if res is not None and res.ok:
            rows = res.json()
            if rows:
                return rows[0]
    except Exception as exc:  # noqa: BLE001
        print(f"[upscale-job] status GET failed {job_id}: {exc}", flush=True)
    return None


def _upload_upscale_image(user_id: str, job_id: str, img_bytes: bytes, ext: str = "png"):
    """完成画像を upscale-results バケット（public）へ upsert し、公開 URL を返す。
    ストレージ不通なら None。ext は "png" / "webp" / "jpeg"。"""
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        return None
    ext = (ext or "png").lstrip(".").lower()
    mime = {"png": "image/png", "webp": "image/webp", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(
        ext, "image/png"
    )
    obj_path = f"{user_id or 'anon'}/{job_id}.{ext}"
    try:
        res = requests.post(
            f"{supabase_url}/storage/v1/object/{_UPSCALE_RESULTS_BUCKET}/{obj_path}",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": mime,
                "x-upsert": "true",
            },
            data=img_bytes,
            timeout=180,
        )
        res.raise_for_status()
        return f"{supabase_url}/storage/v1/object/public/{_UPSCALE_RESULTS_BUCKET}/{obj_path}"
    except Exception as exc:  # noqa: BLE001
        print(f"[upscale-job] image upload failed ({obj_path}): {exc}", flush=True)
        return None


def _refund_upscale_credits(user_id: str, amount: int) -> None:
    """失敗ジョブの返金（best-effort・最大 1 回）。profiles.credits に加算。"""
    if not user_id or not amount or amount <= 0:
        return
    try:
        res = _supabase_request(
            "GET", "/rest/v1/profiles",
            params={"id": f"eq.{user_id}", "select": "credits"},
        )
        if res is None or not res.ok or not res.json():
            return
        current = res.json()[0].get("credits") or 0
        _supabase_request(
            "PATCH", "/rest/v1/profiles",
            params={"id": f"eq.{user_id}"},
            json={"credits": current + int(amount)},
            headers={"Prefer": "return=minimal"},
        )
        print(f"[upscale-job] refunded {amount}C to {user_id}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[upscale-job] refund failed {user_id}: {exc}", flush=True)


# ---------------------------------------------------------------------------
# Stage 1: CPU プリキャッシュ（GPU が要る重みを全部 CPU で Volume へ）
# ---------------------------------------------------------------------------
@app.function(
    image=precache_image,
    timeout=60 * 60,
    cpu=8,
    memory=16384,
    volumes={MODELS_DIR: vol},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    scaledown_window=2,
)
def ensure_upscalers_cached(models=None) -> dict:
    """有効モデルの重みを CPU で Volume へ。GPU 側の @modal.enter は DL 0s。
    先頭で残容量をログ（Volume は 1TB 上限に接近中 — modal-volume-storage-1tb-limit）。"""
    from huggingface_hub import hf_hub_download

    _apply_hf_cache_env()
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] vol.reload skipped: {exc}", flush=True)

    # 残容量ログ（df は Volume マウント先で概算になる）。
    try:
        st = os.statvfs(MODELS_DIR)
        free_gb = st.f_bavail * st.f_frsize / (1024**3)
        total_gb = st.f_blocks * st.f_frsize / (1024**3)
        print(f"[cache] volume approx: free={free_gb:.0f}GB / total={total_gb:.0f}GB", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] statvfs skipped: {exc}", flush=True)

    token = None
    for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"):
        v = (os.environ.get(k) or "").strip()
        if v and v.lower() not in {"", "replace_me", "changeme", "your_token_here"}:
            token = v
            break

    keys = models or _enabled_models()
    report: dict = {"models": {}, "files": {}}
    t0 = time.time()

    for key in keys:
        reg = UPSCALER_REGISTRY.get(key)
        if not reg:
            report["models"][key] = "UNKNOWN"
            continue
        model_ok = True
        for subdir, filename, hf_repo, hf_filename in reg["model_files"]:
            dest_dir = os.path.join(MODELS_DIR, subdir)
            os.makedirs(dest_dir, exist_ok=True)
            dest = os.path.join(dest_dir, filename)
            if os.path.exists(dest) and os.path.getsize(dest) > 0:
                report["files"][f"{subdir}/{filename}"] = "present"
                continue
            try:
                got = hf_hub_download(
                    repo_id=hf_repo,
                    filename=hf_filename,
                    local_dir=dest_dir,
                    token=token,
                )
                # local_dir 直下の名前が hf_filename と違う場合は rename。
                if os.path.basename(got) != filename:
                    os.replace(got, dest)
                report["files"][f"{subdir}/{filename}"] = f"downloaded ({os.path.getsize(dest)} B)"
            except Exception as exc:  # noqa: BLE001
                model_ok = False
                report["files"][f"{subdir}/{filename}"] = f"FAIL: {exc}"
        report["models"][key] = "OK" if model_ok else "PARTIAL"

    try:
        vol.commit()
    except Exception as exc:  # noqa: BLE001
        print(f"[cache] vol.commit skipped: {exc}", flush=True)

    report["elapsed_s"] = round(time.time() - t0, 1)
    print(f"[cache] {json.dumps(report, ensure_ascii=False)}", flush=True)
    return report


# ---------------------------------------------------------------------------
# ComfyUI 起動ヘルパー（GPU クラスと CPU probe で共有）
# ---------------------------------------------------------------------------
def _link_volume_custom_nodes() -> None:
    """Volume 側 custom_nodes/*（管理者が UI から入れたもの）を COMFY_DIR へ symlink。
    image に焼いた同名ディレクトリが勝つ。"""
    volume_nodes_dir = os.path.join(MODELS_DIR, CUSTOM_NODES_SUBDIR)
    os.makedirs(volume_nodes_dir, exist_ok=True)
    for name in os.listdir(volume_nodes_dir):
        src = os.path.join(volume_nodes_dir, name)
        if not os.path.isdir(src):
            continue
        dst = os.path.join(COMFY_DIR, "custom_nodes", name)
        if os.path.islink(dst):
            os.remove(dst)
        elif os.path.exists(dst):
            continue
        os.symlink(src, dst)


def _start_comfy(extra_argv: list, wait_timeout: int = 240) -> "subprocess.Popen":
    """ComfyUI を起動して /system_stats が返るまで待つ。"""
    import urllib.request

    # --use-sage-attention は sageattention 未導入だと ComfyUI が起動時に
    # ハード fail する（code 255）。image ビルドの SageAttention は
    # `|| echo ... SDPA fallback` で fail-open にしてあるので、実際に
    # import できるときだけ渡す。できなければ ComfyUI native の
    # comfy_kitchen(cuda/eager) attention に自動フォールバックする。
    argv_extra = list(extra_argv)
    if "--use-sage-attention" in argv_extra:
        try:
            import sageattention  # noqa: F401
        except Exception as exc:  # noqa: BLE001
            print(
                f"[comfy] sageattention 未導入（{type(exc).__name__}）— "
                "--use-sage-attention を外し native attention で起動",
                flush=True,
            )
            argv_extra = [a for a in argv_extra if a != "--use-sage-attention"]

    argv = ["python", "main.py", *argv_extra, "--listen", "127.0.0.1", "--port", str(COMFY_PORT)]
    proc = subprocess.Popen(argv, cwd=COMFY_DIR)
    deadline = time.time() + wait_timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"ComfyUI exited early (code {proc.returncode}); argv={argv}")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{COMFY_PORT}/system_stats", timeout=2)
            return proc
        except Exception:  # noqa: BLE001
            time.sleep(1)
    proc.terminate()
    raise RuntimeError("ComfyUI did not come up within timeout")


def _object_info(class_type: str) -> dict | None:
    try:
        import requests

        r = requests.get(f"http://127.0.0.1:{COMFY_PORT}/object_info/{class_type}", timeout=5)
        if r.ok and isinstance(r.json(), dict):
            return r.json().get(class_type)
    except Exception:  # noqa: BLE001
        pass
    return None


# ---------------------------------------------------------------------------
# Stage 2: CPU import / ノード登録 / ワークフロー生成 probe（GPU 課金なし）
# ---------------------------------------------------------------------------
@app.function(
    image=image,  # 本番 GPU と同じ image を CPU 起動
    volumes={MODELS_DIR: vol},
    timeout=20 * 60,
    cpu=4,
    memory=16384,
    scaledown_window=2,
)
def probe_imports() -> dict:
    """CPU で確認できる範囲を全部やる:
      (1) comfy_api.latest の import 連鎖
      (2) ComfyUI を --cpu で起動できる
      (3) SeedVR2 ノードが /object_info に登録される（+ 実際のソケット名を吸い出す）
      (4) build_upscale_workflow('seedvr2_7b', …) が妥当な JSON を生成する
    GPU でしか確認できないのは実推論 / VRAM / 時間のみ。"""
    import traceback

    _apply_hf_cache_env()
    try:
        vol.reload()
    except Exception:  # noqa: BLE001
        pass

    result: dict = {}

    def _step(name, fn):
        try:
            result[name] = fn() or "OK"
        except Exception as exc:  # noqa: BLE001
            result[name] = f"FAIL: {exc}"
            result[name + "_tb"] = traceback.format_exc()[-1600:]

    def _comfy_api_import():
        import sys

        if COMFY_DIR not in sys.path:
            sys.path.insert(0, COMFY_DIR)
        from comfy_api.latest import io  # noqa: F401

        return "OK (comfy_api.latest.io importable)"

    def _ull_prep_import():
        from ull_image_prep import normalize_to_png_bytes  # noqa: F401

        return "OK"

    def _workflow_build():
        wf = build_upscale_workflow("seedvr2_7b", {}, "probe_input.png")
        assert wf["seedvr2"]["class_type"] == "SeedVR2VideoUpscaler"
        json.dumps(wf)  # シリアライズ可能か
        return f"OK ({len(wf)} nodes)"

    _step("comfy_api_import", _comfy_api_import)
    _step("ull_image_prep_import", _ull_prep_import)
    _step("workflow_build", _workflow_build)

    _link_volume_custom_nodes()
    proc = None
    try:
        proc = _start_comfy(["--cpu"], wait_timeout=300)
        result["comfy_boot"] = "OK"

        for ct in ("SeedVR2VideoUpscaler", "SeedVR2LoadDiTModel", "SeedVR2LoadVAEModel",
                   "LoadImage", "SaveImage",
                   "UpscaleModelLoader", "ImageUpscaleWithModel"):
            info = _object_info(ct)
            if info:
                req = list((info.get("input", {}).get("required", {}) or {}).keys())
                opt = list((info.get("input", {}).get("optional", {}) or {}).keys())
                result[f"node:{ct}"] = {"required": req, "optional": opt}
            else:
                result[f"node:{ct}"] = "NOT REGISTERED"
    except Exception as exc:  # noqa: BLE001
        result["comfy_boot"] = f"FAIL: {exc}"
        result["comfy_boot_tb"] = traceback.format_exc()[-1600:]
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()

    print(f"[probe] {json.dumps(result, ensure_ascii=False, default=str)}", flush=True)
    return result


@app.local_entrypoint()
def probe():
    """modal run modal_seedvr2_worker.py::probe
    CPU プリキャッシュ → CPU import/ノード/ワークフロー probe。GPU 課金なし。"""
    print("=== ensure_upscalers_cached (CPU) ===")
    cache = ensure_upscalers_cached.remote()
    for k, v in cache.items():
        print(f"  {k}: {v}")
    print("\n=== probe_imports (CPU) ===")
    r = probe_imports.remote()
    for k, v in r.items():
        print(f"  {k}: {v}")


# ---------------------------------------------------------------------------
# Stage 3: GPU 推論クラス
#   30 秒 Keep-Warm 規格（CLAUDE.md §1）+ min_containers=0。超解像は「続けて
#   何枚も掛ける」対話型なのでフロントの 30 秒カウントダウンと連動させる。
# ---------------------------------------------------------------------------
@app.cls(
    image=image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    retries=0,
    timeout=20 * 60,
    scaledown_window=30,
    min_containers=0,
    secrets=[
        modal.Secret.from_name("wan-animate-auth"),
        modal.Secret.from_name("huggingface-secret"),
        # SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — 非同期ジョブが upscale_jobs を
        # 直接 PATCH / rpc し、upscale-results バケットへ画像を上げるために必要。
        modal.Secret.from_name("supabase-model-downloads"),
    ],
)
class SeedVR2Worker:
    @modal.enter()
    def setup(self):
        _apply_hf_cache_env()
        try:
            vol.reload()
        except Exception as exc:  # noqa: BLE001
            print(f"[seedvr2] vol.reload skipped: {exc}", flush=True)
        _link_volume_custom_nodes()
        # BF16 フル精度・オフロードなし（CLAUDE.md §1）。--gpu-only で重みを VRAM に
        # ピン留め、SageAttention を使う。SeedVR2 の offload は workflow 側で "none"。
        self._proc = _start_comfy(
            ["--gpu-only", "--use-sage-attention"], wait_timeout=300
        )
        print(f"[seedvr2] ComfyUI ready (VRAM={_vram_gb()}GB)", flush=True)

    def _write_input(self, raw: bytes, filename: str) -> str:
        """入力を共通正規化レイヤーに通して ComfyUI の input/ へ。"""
        from ull_image_prep import ImagePrepError, normalize_to_png_bytes

        input_dir = os.path.join(COMFY_DIR, "input")
        os.makedirs(input_dir, exist_ok=True)
        payload = raw
        try:
            payload = normalize_to_png_bytes(
                raw,
                max_edge=INPUT_IMG_MAX_EDGE,
                min_edge=INPUT_IMG_MIN_EDGE,
                multiple=INPUT_IMG_MULTIPLE,
                bg=(255, 255, 255),
            )
        except ImagePrepError as exc:
            print(f"[inputs] normalize skipped: {exc!r}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[inputs] normalize error (raw): {exc!r}", flush=True)
        out_name = "ull_upscale_in.png"
        with open(os.path.join(input_dir, out_name), "wb") as f:
            f.write(payload)
        return out_name

    def _run_workflow(self, workflow: dict) -> tuple[bytes, str]:
        import uuid

        import requests

        output_dir = os.path.join(COMFY_DIR, "output")
        os.makedirs(output_dir, exist_ok=True)
        pre = {
            os.path.join(r, f)
            for r, _d, fs in os.walk(output_dir)
            for f in fs
        }
        resp = requests.post(
            f"http://127.0.0.1:{COMFY_PORT}/prompt",
            json={"prompt": workflow, "client_id": str(uuid.uuid4())},
            timeout=30,
        )
        if not resp.ok:
            try:
                body = json.dumps(resp.json(), ensure_ascii=False)[:4000]
            except ValueError:
                body = resp.text[:4000]
            raise RuntimeError(f"ComfyUI /prompt rejected workflow ({resp.status_code}): {body}")
        prompt_id = resp.json().get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"/prompt returned no prompt_id: {resp.text[:500]}")

        deadline = time.time() + _env_int("SEEDVR2_WORKFLOW_TIMEOUT_S", 15 * 60)
        while time.time() < deadline:
            hist = requests.get(
                f"http://127.0.0.1:{COMFY_PORT}/history/{prompt_id}", timeout=30
            ).json()
            if prompt_id in hist:
                outputs = hist[prompt_id].get("outputs", {})
                for node_output in outputs.values():
                    for key in ("images", "gifs", "video", "videos"):
                        for item in node_output.get(key, []):
                            p = os.path.join(output_dir, item.get("subfolder", ""), item["filename"])
                            if os.path.exists(p):
                                with open(p, "rb") as f:
                                    return f.read(), item["filename"]
                post = {
                    os.path.join(r, f)
                    for r, _d, fs in os.walk(output_dir)
                    for f in fs
                }
                new = sorted(post - pre, key=os.path.getmtime)
                if new:
                    with open(new[-1], "rb") as f:
                        return f.read(), os.path.basename(new[-1])
                raise RuntimeError(f"workflow finished but produced no output: {json.dumps(outputs)[:2000]}")
            time.sleep(2)
        raise TimeoutError("timed out waiting for ComfyUI")

    def _do_upscale(self, image_spec: str, model_key: str, params: dict) -> dict:
        """アップスケール本体（run_upscale / run_upscale_job 共通）。"""
        if model_key not in UPSCALER_REGISTRY:
            raise fastapi.HTTPException(status_code=400, detail=f"unknown model_key {model_key!r}")
        if model_key not in _enabled_models():
            raise fastapi.HTTPException(status_code=400, detail=f"model {model_key!r} not available yet")

        raw = _load_input_bytes(image_spec)
        in_name = self._write_input(raw, "in.png")
        workflow = build_upscale_workflow(model_key, params or {}, in_name)

        t0 = time.time()
        with _VramPeak() as vp:
            data, filename = self._run_workflow(workflow)
        elapsed = round(time.time() - t0, 2)

        out_w = out_h = None
        try:
            from PIL import Image

            with Image.open(io.BytesIO(data)) as im:
                out_w, out_h = im.size
        except Exception:  # noqa: BLE001
            pass

        # 大きい出力（8K PNG は ~30MB、横長だと 50MB+）は WebP q92 へ再エンコード。
        # 視覚的にほぼ無損失で、ストレージのファイル上限に安全に収まる。
        # しきい値は env で調整可（0 で無効）。
        webp_threshold = _env_int("SEEDVR2_WEBP_ABOVE_BYTES", 20 * 1024 * 1024)
        if webp_threshold and len(data) > webp_threshold:
            try:
                from PIL import Image

                with Image.open(io.BytesIO(data)) as im:
                    im = im.convert("RGB")
                    buf = io.BytesIO()
                    im.save(buf, format="WEBP", quality=92, method=5)
                new_data = buf.getvalue()
                if new_data and len(new_data) < len(data):
                    print(
                        f"[seedvr2] re-encoded PNG {len(data)/1e6:.1f}MB → "
                        f"WebP {len(new_data)/1e6:.1f}MB",
                        flush=True,
                    )
                    data = new_data
                    filename = filename.rsplit(".", 1)[0] + ".webp"
            except Exception as exc:  # noqa: BLE001
                print(f"[seedvr2] webp re-encode skipped: {exc}", flush=True)

        print(
            f"[seedvr2] {model_key} -> {filename} {out_w}x{out_h} in {elapsed}s "
            f"VRAM peak={vp.peak}GB now={_vram_gb()}GB",
            flush=True,
        )
        return {
            "data": data,
            "filename": filename,
            "model_key": model_key,
            "elapsed_time": elapsed,
            "vram_used_gb": _vram_gb(),
            "vram_peak_gb": vp.peak,
            "out_width": out_w,
            "out_height": out_h,
        }

    @modal.method()
    def run_upscale(self, image_spec: str, model_key: str = "seedvr2_7b",
                    params: dict | None = None) -> dict:
        r = self._do_upscale(image_spec, model_key, params or {})
        return {
            "image_base64": base64.b64encode(r["data"]).decode("ascii"),
            "filename": r["filename"],
            "model_key": r["model_key"],
            "elapsed_time": r["elapsed_time"],
            "vram_used_gb": r["vram_used_gb"],
            "vram_peak_gb": r["vram_peak_gb"],
            "out_width": r["out_width"],
            "out_height": r["out_height"],
        }

    @modal.method()
    def run_upscale_job(self, payload: dict) -> dict:
        """完全非同期ジョブ本体。`upscale_generate_dispatch` が .spawn() する。

        入力: { job_id, user_id, credits_cost, max_allowed_time?,
                image(base64|url), model_key?, preset?, params?{target_short,...} }
        upscale_jobs を直接 PATCH（Next のリクエストはもう生きていない）。
        """
        job_id = str(payload.get("job_id") or "")
        user_id = str(payload.get("user_id") or "")
        credits_cost = int(payload.get("credits_cost") or 0)
        model_key = payload.get("model_key") or "seedvr2_7b"
        preset = payload.get("preset") or ""
        params = payload.get("params") or {}
        image_spec = payload.get("image") or payload.get("image_b64") or ""

        # idempotency ガード: Modal のクラッシュ由来リトライで二重課金 / 二重生成
        # しないよう、既に終端状態なら即 no-op。
        existing = _get_upscale_job_status(job_id)
        if existing and existing.get("status") in ("completed", "failed"):
            print(f"[upscale-job] {job_id} already {existing['status']} — no-op", flush=True)
            return {"ok": True, "skipped": True}

        if not image_spec:
            _patch_upscale_job(job_id, {"status": "failed", "error_message": "image is required"})
            _refund_upscale_credits(user_id, credits_cost)
            return {"ok": False, "error": "image is required"}

        _patch_upscale_job(job_id, {"status": "processing"})

        # 損切り: 別スレッドで max_allowed_time を監視し、超過したら os._exit で
        # コンテナごと落とす（GPU 焼き逃げ防止）。angle worker と違い 1 枚だけの
        # 単発ジョブなので協調停止ポイントが無く、強制終了でよい。retries=0 なので
        # リトライループにはならない。
        # ⚠️ この関数を抜けたら必ず _wd_stop.set() すること。さもないと daemon
        # スレッドが生き残り、同じ warm コンテナが処理する次のジョブ実行中に
        # os._exit を撃つ（＝別ジョブの巻き添え）。
        import threading

        try:
            mat = float(payload.get("max_allowed_time") or 0)
        except (TypeError, ValueError):
            mat = 0.0
        _wd_stop = threading.Event()

        if mat > 0:
            def _watchdog():
                if _wd_stop.wait(mat):
                    return  # 正常終了 — 何もしない
                print(
                    f"[upscale-job][WATCHDOG] {job_id}: 許容 {int(mat)}s 超過 → os._exit(1)",
                    flush=True,
                )
                _patch_upscale_job(
                    job_id,
                    {"status": "failed", "error_message": "処理時間の上限を超えました。"},
                )
                _refund_upscale_credits(user_id, credits_cost)
                os._exit(1)

            threading.Thread(target=_watchdog, daemon=True).start()

        try:
            r = self._do_upscale(image_spec, model_key, params)
        except Exception as exc:  # noqa: BLE001
            _wd_stop.set()
            msg = f"{type(exc).__name__}: {exc}"[:500]
            print(f"[upscale-job] {job_id} FAILED: {msg}", flush=True)
            _patch_upscale_job(job_id, {"status": "failed", "error_message": msg})
            _refund_upscale_credits(user_id, credits_cost)
            return {"ok": False, "error": msg}
        _wd_stop.set()

        _ext = (r.get("filename") or "out.png").rsplit(".", 1)[-1].lower()
        url = _upload_upscale_image(user_id, job_id, r["data"], _ext)
        meta = {
            "vram_used_gb": r["vram_used_gb"],
            "vram_peak_gb": r["vram_peak_gb"],
            "elapsed_time": r["elapsed_time"],
            "out_width": r["out_width"],
            "out_height": r["out_height"],
            "out_bytes": len(r["data"]),
            "model_key": r["model_key"],
            "preset": preset,
        }
        if url:
            _patch_upscale_job(job_id, {"status": "completed", "result_url": url})
            _merge_upscale_metadata(job_id, meta)
            print(f"[upscale-job] {job_id} completed -> {url}", flush=True)
            return {"ok": True, "result_url": url}

        # ストレージ不通 — 課金しておいて結果を返せないのは避ける。返金 + failed。
        _patch_upscale_job(
            job_id,
            {"status": "failed", "error_message": "結果画像の保存に失敗しました。"},
        )
        _merge_upscale_metadata(job_id, meta)
        _refund_upscale_credits(user_id, credits_cost)
        return {"ok": False, "error": "upload failed"}

    @modal.fastapi_endpoint(method="POST")
    def upscale(self, item: dict, request: fastapi.Request):
        """【同期】1 リクエストで 1 枚アップスケールして即返す。
        入力: {image: <base64|url>, model_key?, params?}
        出力: {image_base64, filename, model_key, elapsed_time, vram_used_gb}
        """
        _authorize(request)
        image_spec = item.get("image") or item.get("image_b64") or ""
        if not image_spec:
            raise fastapi.HTTPException(status_code=400, detail="image is required")
        return self.run_upscale.local(
            image_spec,
            model_key=item.get("model_key", "seedvr2_7b"),
            params=item.get("params") or {},
        )

    @modal.fastapi_endpoint(method="GET")
    def models(self, request: fastapi.Request):
        """フロントの超解像タブ用のモデル一覧（1 行説明つき）。"""
        _authorize(request)
        return {"models": public_registry()}


# ---------------------------------------------------------------------------
# 非同期ディスパッチ（GPU なし・.spawn() して即 ACK）— angle worker と同型。
# ---------------------------------------------------------------------------
@app.function(
    image=dispatch_image,
    timeout=300,
    scaledown_window=30,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def upscale_generate_dispatch(item: dict, request: fastapi.Request):
    """POST 非同期ディスパッチ。1 秒以内に ACK し、実処理は .spawn() 側へ委譲。

    入力: { job_id, user_id, credits_cost, max_allowed_time?,
            image(base64|url), model_key?, preset?, params? }
    出力: { ok: true, job_id, call_id }
    """
    _authorize(request)

    job_id = str(item.get("job_id") or "")
    if not job_id:
        raise fastapi.HTTPException(status_code=400, detail="job_id is required")
    if not (item.get("image") or item.get("image_b64")):
        raise fastapi.HTTPException(status_code=400, detail="image is required")

    call = SeedVR2Worker().run_upscale_job.spawn(item)
    print(
        f"[upscale-dispatch] {job_id}: model={item.get('model_key')} "
        f"preset={item.get('preset')} max_allowed_time={item.get('max_allowed_time')!r}",
        flush=True,
    )
    return {"ok": True, "job_id": job_id, "call_id": call.object_id}


# ---------------------------------------------------------------------------
# GPU smoke probe（CPU probe がグリーンになってから・別途承認のうえ実行）
# ---------------------------------------------------------------------------
@app.function(
    image=image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    retries=0,
    timeout=20 * 60,
    scaledown_window=30,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
def gpu_smoke_fn(models=None) -> dict:
    """各有効モデルにテストパターンを 1 枚通し、VRAM・時間を返す。"""
    from PIL import Image

    _apply_hf_cache_env()
    try:
        vol.reload()
    except Exception:  # noqa: BLE001
        pass
    _link_volume_custom_nodes()

    # 512x512 のグラデーション + 市松（ノイズ除去/シャープの効きを見る用）
    buf = io.BytesIO()
    im = Image.new("RGB", (512, 512))
    px = im.load()
    for y in range(512):
        for x in range(512):
            c = ((x // 16) + (y // 16)) % 2
            px[x, y] = (x // 2, y // 2, 128 if c else 200)
    im.save(buf, format="PNG")
    test_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    proc = _start_comfy(["--gpu-only", "--use-sage-attention"], wait_timeout=300)
    report: dict = {"vram_boot_gb": _vram_gb(), "models": {}}
    try:
        worker = SeedVR2Worker()  # 同一プロセスでなく別 image だがメソッドは local 実行不可
        # gpu_smoke_fn は独立関数なので SeedVR2Worker のロジックを最小再現する。
        from ull_image_prep import normalize_to_png_bytes

        input_dir = os.path.join(COMFY_DIR, "input")
        os.makedirs(input_dir, exist_ok=True)
        payload = normalize_to_png_bytes(base64.b64decode(test_b64),
                                         max_edge=INPUT_IMG_MAX_EDGE, min_edge=0,
                                         multiple=INPUT_IMG_MULTIPLE)
        with open(os.path.join(input_dir, "smoke_in.png"), "wb") as f:
            f.write(payload)

        for key in (models or _enabled_models()):
            # 静止画 1 枚なので batch_size=1（4n+1・フレーム数一致が最適）。
            wf = build_upscale_workflow(key, {"batch_size": 1}, "smoke_in.png")
            t0 = time.time()
            try:
                # _run_workflow を関数内で最小再現
                import uuid

                import requests

                r = requests.post(
                    f"http://127.0.0.1:{COMFY_PORT}/prompt",
                    json={"prompt": wf, "client_id": str(uuid.uuid4())},
                    timeout=30,
                )
                r.raise_for_status()
                pid = r.json()["prompt_id"]
                ok = False
                while time.time() - t0 < 15 * 60:
                    h = requests.get(
                        f"http://127.0.0.1:{COMFY_PORT}/history/{pid}", timeout=30
                    ).json()
                    if pid in h:
                        ok = bool(h[pid].get("outputs"))
                        break
                    time.sleep(2)
                report["models"][key] = {
                    "ok": ok,
                    "elapsed_s": round(time.time() - t0, 1),
                    "vram_gb": _vram_gb(),
                }
            except Exception as exc:  # noqa: BLE001
                report["models"][key] = {"ok": False, "error": str(exc)[:400]}
        _ = worker
    finally:
        if proc.poll() is None:
            proc.terminate()

    print(f"[gpu_smoke] {json.dumps(report, ensure_ascii=False)}", flush=True)
    return report


@app.local_entrypoint()
def gpu_smoke():
    """modal run modal_seedvr2_worker.py::gpu_smoke — GPU 課金あり。CPU probe 後に。"""
    r = gpu_smoke_fn.remote()
    print(json.dumps(r, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------------------
# ローカル一発 CLI（GPU 実行）
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def main(
    image_path: str,
    model: str = "seedvr2_7b",
    target_short: int = DEFAULT_TARGET_SHORT,
    max_edge: int = DEFAULT_MAX_RESOLUTION,
    color_correction: str = "lab",
    out_dir: str = "./upscale_out",
):
    """modal run modal_seedvr2_worker.py::main --image-path ./in.png --model seedvr2_7b

    8K/16K 実測: --target-short 4320 --max-edge 8192 等（max_resolution を上げないと
    レジストリ既定 4096 でクランプされる）。--color-correction none で LAB 転写を
    skip した時間も比較できる。
    """
    src = pathlib.Path(image_path).expanduser()
    if not src.is_file():
        raise SystemExit(f"--image-path is not a file: {src}")

    ensure_upscalers_cached.remote([model])
    b64 = base64.b64encode(src.read_bytes()).decode("ascii")
    # 8K/16K 実測用に Modal 強制 timeout を 45 分へ（既定 20 分だと 16K が切れうる）。
    worker = SeedVR2Worker.with_options(timeout=45 * 60)
    result = worker().run_upscale.remote(
        b64,
        model_key=model,
        params={
            "target_short": target_short,
            "max_resolution": max_edge,
            "batch_size": 1,
            "color_correction": color_correction,
        },
    )
    dst = pathlib.Path(out_dir).expanduser()
    dst.mkdir(parents=True, exist_ok=True)
    out = dst / result["filename"]
    out.write_bytes(base64.b64decode(result["image_base64"]))
    print(
        f"[main] {model} {result.get('out_width')}x{result.get('out_height')} "
        f"in {result['elapsed_time']}s  VRAM peak={result.get('vram_peak_gb')}GB "
        f"end={result['vram_used_gb']}GB -> {out}"
    )


@app.local_entrypoint()
def bench(
    image_dir: str,
    model: str = "seedvr2_7b",
    target_short: int = DEFAULT_TARGET_SHORT,
    out_dir: str = "./upscale_out",
):
    """品質 + 性能ベンチ: image_dir 内の画像を全部 SeedVR2 に通し、最初の 1 枚は
    warm 再実行して cold/warm を比較。出力を out_dir へ保存。

    modal run modal_seedvr2_worker.py::bench --image-dir ./upscale_bench
    """
    exts = {".png", ".jpg", ".jpeg", ".jfif", ".webp", ".bmp"}
    src_dir = pathlib.Path(image_dir).expanduser()
    imgs = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in exts)
    # 同名 .jfif/.jpg の重複を落とす（stem 単位で 1 つ）。
    seen: dict = {}
    for p in imgs:
        seen.setdefault(p.stem, p)
    imgs = list(seen.values())
    if not imgs:
        raise SystemExit(f"no images in {src_dir}")

    ensure_upscalers_cached.remote([model])
    dst = pathlib.Path(out_dir).expanduser()
    dst.mkdir(parents=True, exist_ok=True)

    plan = list(imgs) + [imgs[0]]  # 末尾に 1 枚目をもう一度（warm）
    rows = []
    for i, src in enumerate(plan):
        b64 = base64.b64encode(src.read_bytes()).decode("ascii")
        r = SeedVR2Worker().run_upscale.remote(
            b64, model_key=model, params={"target_short": target_short, "batch_size": 1},
        )
        tag = f"{src.stem}{'_warm' if i == len(plan) - 1 else ''}"
        out = dst / f"{tag}__{r['filename']}"
        out.write_bytes(base64.b64decode(r["image_base64"]))
        rows.append((tag, r["elapsed_time"], r.get("vram_peak_gb"), r.get("vram_used_gb")))
        print(f"[bench] {tag}: {r['elapsed_time']}s  peak={r.get('vram_peak_gb')}GB -> {out.name}", flush=True)

    print("\n=== SeedVR2 bench ===")
    print(f"{'image':<40} {'sec':>8} {'peak GB':>9} {'end GB':>8}")
    for tag, sec, peak, end in rows:
        print(f"{tag:<40} {sec:>8} {str(peak):>9} {str(end):>8}")
