"""
SDXL LoRA training worker on Modal — kohya-ss/sd-scripts backend, dedicated to
the SDXL-family LoRA Studio presets (Illustrious XL / Juggernaut XL,
`arch: "sdxl"` in src/lib/loraModels.ts).

Why a SEPARATE worker instead of routing SDXL through modal_lora_worker.py's
ai-toolkit pipeline: real-world comparison (host, 2026-09-15) found ai-toolkit
produces noticeably worse SDXL LoRAs than kohya-ss/sd-scripts. Investigation
found no single functional bug — ai-toolkit's active development has shifted
to newer DiT architectures (FLUX.1/2, Qwen-Image, Z-Image); SDXL support is
present but secondary, while sd-scripts is still the mature, heavily-tuned
"home turf" for SDXL's UNet + dual-CLIP architecture (min_snr_gamma,
noise_offset, zero_terminal_snr, fine bucketing controls, all refined over
years of real SDXL-specific use).

This is NOT a "leverage Blackwell's huge VRAM" worker the way the other GPU
workers in this project are (CLAUDE.md §0) — SDXL trains comfortably on a
16GB consumer GPU. Built anyway because a specific paying customer wants this
automated (host decision, 2026-09-15). Cost-tier decision therefore starts
CHEAP (see GPU_REQUEST below) rather than defaulting to Blackwell, and gets
compared against Blackwell on real $/job numbers before committing either way.

Model / license (CLAUDE.md §5, confirmed 2026-09-15):
  stabilityai/stable-diffusion-xl-base-1.0 — CreativeML Open RAIL++-M,
  commercial SaaS use permitted. Already the de-facto base for this project's
  existing SDXL presets (Juggernaut XL / Illustrious XL, trained externally
  today — see loraModels.ts).
  kohya-ss/sd-scripts — Apache-2.0, commercial use permitted (confirmed
  2026-09-15; some vendored components may carry separate licenses — verify
  anything actually used beyond the core LoRA training path before shipping).

CUDA / PyTorch (CLAUDE.md §1 exception, added 2026-09-15): the project's
blanket "always cu130" rule was decided for ComfyUI-based workers and does
NOT apply here. sd-scripts' own README documents testing against PyTorch
2.6.0+ on CUDA 12.4 (cu124) as the general baseline — that's what this image
uses, matching the CHEAP, non-Blackwell GPU tier below (Blackwell-specific
guidance, cu128/129, isn't the relevant constraint for an L40S/Ada-class
card). Revisit if/when this worker is ever run on Blackwell.

Status: CPU-only import/dependency probe stage (CLAUDE.md §1 — "CPUで
import/資産をグリーンにしてからGPU"). No training logic yet.

Deploy / run:
  modal deploy modal_sdxl_lora_worker.py
  modal run modal_sdxl_lora_worker.py::probe_imports   (CPU-only, no GPU cost)

Env overrides:
  SDXL_WORKER_GPU   pin a GPU tier (default: "L40S" — see module docstring)
  SD_SCRIPTS_REF    sd-scripts git ref (default: a pinned release tag, see below)
"""

import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

import fastapi
import modal

app = modal.App("ull-sdxl-lora-worker")

MODELS_DIR = "/models"
SD_SCRIPTS_DIR = "/root/sd-scripts"

# New worker under construction -> latest tagged release (CLAUDE.md §1:
# "新規ワーカーを初めて構築する時点では、その時点の最新版を使うこと"). Once
# this goes into real production use, PIN it and stop tracking main/newer
# tags without the 3-point re-verification CLAUDE.md §1 requires (changelog
# review, confirm no regression of whatever we depended on, re-test). Latest
# tag as of 2026-09-15: v0.11.1 (verify at
# https://github.com/kohya-ss/sd-scripts/tags before reusing this as a
# template much later).
SD_SCRIPTS_REF = os.environ.get("SD_SCRIPTS_REF", "v0.11.1")

# Cheap-by-default (see module docstring): SDXL doesn't need Blackwell's huge
# VRAM (fits comfortably in 16GB locally per host's own real-world use), so
# this starts on a non-Blackwell, non-B300 tier and only moves to Blackwell if
# a real $/job comparison shows it's actually cheaper despite the higher
# hourly rate. L40S (48GB, Ada Lovelace) already has precedent in this repo
# (scripts/modal_wan_animate.py's "Standard" tier) as the go-to non-Blackwell
# option here.
GPU_REQUEST = os.environ.get("SDXL_WORKER_GPU", "").strip() or "L40S"

# 2026-09-20: 既定 False（無効）。理由は _build_train_args() 内のコメント参照。
# このワーカーは L40S(48GB) なので、OOM 時の逃げ道として env を残してある。
SDXL_GRADIENT_CHECKPOINTING = os.environ.get("SDXL_GRADIENT_CHECKPOINTING", "0").strip() not in (
    "",
    "0",
    "false",
    "False",
)

# --- 原価割れ損切り（cost-guard / CLAUDE.md §3）------------------------------
# ai-toolkit ワーカー（modal_lora_worker.py）の _cost_cap_seconds 相当をこちらへ
# 移植したもの（2026-09-21）。それまでこのワーカーは下の timeout=10800 という
# 固定の器だけに頼っていて、「正しく課金されているが想定より遅いジョブ」と
# 「暴走して原価を食い潰すジョブ」を区別できなかった。
#
# 本筋は **Next.js 側が payload の cost_cap_seconds として渡してくる値**
# （src/lib/pricing/costGuard.server.ts が pricing_knobs から算出、admin で
# 編集でき worker 再デプロイ不要）。ここにある定数はその payload が無い／0 の
# ときのフォールバックと、env による緊急上書き用。
#
# 判定は「実測 s/it の trimmed 平均 → 残り step の所要を予測 → cap を超えたら
# graceful stop + 中間チェックポイント保存 + 全額返金」。JIT ウォームアップや
# 保存 I/O に引っ張られないよう SDXL_COST_MIN_STEP step 経過してから効かせる。
SDXL_COST_MIN_STEP = int(os.environ.get("SDXL_COST_MIN_STEP", "50"))
# コンテナの timeout=10800 より必ず手前で止める（graceful stop の猶予 5 分）。
SDXL_ABS_MAX_RUN_S = int(os.environ.get("SDXL_ABS_MAX_RUN_S", str(10800 - 300)))
# credits_cost == 0（内部実行・スモーク）のときだけ使うフォールバック上限。
SDXL_SAFETY_LIMIT_S = int(os.environ.get("SDXL_SAFETY_LIMIT_S", str(3 * 60 * 60)))
# 損切りの緩さ。ai-toolkit 側の ULL_COST_GUARD_MULTIPLIER と同じ意味・同じ既定。
SDXL_COST_GUARD_MULTIPLIER = max(
    1.0, min(float(os.environ.get("ULL_COST_GUARD_MULTIPLIER", "1.4")), 3.0)
)
# s/it のフォールバック基準値。**src/lib/pricing/loraRuntime.ts の
# LORA_SPI_BASELINE.sdxl と同じ値に保つこと**（あちらが課金側の SSOT）。
# 2026-09-20 実測: step 数だけ変えた2回（20step / 120step）の総経過時間を連立で
# 分離して 0.642 s/it・prep 43.2秒。ただし当時は AdamW8bit + gradient_checkpointing
# 有効で、現在の既定（prodigy / gc 無効）より遅い条件なので、**実運用はこれより
# 速い見込み＝過大見積もり＝安全側**。
SDXL_SPI_BASELINE = float(os.environ.get("SDXL_SPI_BASELINE", "0.642"))
# 同じく prep（モデルロード + latent キャッシュ + 保存）の固定分。
# knobDefaults.ts の lora_prep_load_s_sdxl（45秒）に対し、下限計算では
# 取りこぼしが致命的なので厚めに取る。
SDXL_FLOOR_PREP_S = int(os.environ.get("SDXL_FLOOR_PREP_S", str(10 * 60)))
# L40S の時間単価（USD）と円換算。knobDefaults.ts の gpu_usd_per_hour_l40s /
# usd_jpy_rate、credit_to_jpy、lora_margin_target と同じ意味の値。payload が
# 来ないときだけ使うので、knob 側が動いてもこちらは概算で構わない。
SDXL_GPU_USD_PER_HOUR = float(os.environ.get("SDXL_GPU_USD_PER_HOUR", "1.95"))
SDXL_USD_JPY = float(os.environ.get("ULL_USD_JPY", "150"))
SDXL_CREDIT_TO_JPY = float(os.environ.get("ULL_CREDIT_TO_JPY", "1.66"))
SDXL_MARGIN_TARGET = float(os.environ.get("ULL_LORA_MARGIN_TARGET", "0.70"))

# --- CPU-only probe image ---------------------------------------------------
# sd-scripts' own README baseline: PyTorch 2.6.0+, CUDA 12.4 (cu124). Not
# Blackwell-specific guidance (that's cu128/129) since GPU_REQUEST above is
# L40S (Ada), not B200/B300 — see the module docstring's CLAUDE.md §1
# exception note.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0", "wget", "build-essential")
    .pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    # fastapi はこのファイルが **モジュールトップレベル**で import している
    # （64行目）。web エンドポイント用の dispatch_image にしか入れていなかった
    # ため、`image` / `train_image` で動く全関数——CPU probe もスモークも、
    # **本番の train_sdxl_lora_job も**——がモジュール import の時点で
    # `ModuleNotFoundError: No module named 'fastapi'` で落ちていた（2026-09-20
    # 発見）。`import fastapi` は feb4112「本番ジョブライフサイクルを追加」で
    # 入ったもので、それ以前（雛形の 0bbebd0 時点）はスモークが通っていた。
    #
    # 遅延 import では直せない: 1202行目の `request: fastapi.Request` は
    # `@modal.fastapi_endpoint` がシグネチャを検査する際に評価されるため、
    # モジュールトップレベルで解決できている必要がある。よってベース image に
    # 入れる。
    .pip_install("modal", "fastapi[standard]")
    .run_commands(
        f"git clone --depth 1 --branch {SD_SCRIPTS_REF} https://github.com/kohya-ss/sd-scripts.git {SD_SCRIPTS_DIR}",
        f"cd {SD_SCRIPTS_DIR} && pip install -r requirements.txt",
    )
)

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)


@app.function(image=image, timeout=300)
def probe_imports() -> dict:
    """CPU-only — verifies sd-scripts' SDXL LoRA training entrypoint and its
    full dependency chain import cleanly, before any GPU container is ever
    started (CLAUDE.md §1). Returns version info for the deploy log."""
    import sys

    sys.path.insert(0, SD_SCRIPTS_DIR)

    report: dict = {"ok": False, "errors": []}
    try:
        import torch

        report["torch"] = torch.__version__
    except Exception as exc:  # noqa: BLE001
        report["errors"].append(f"torch import failed: {exc!r}")

    try:
        import library.train_util  # noqa: F401
        import library.sdxl_train_util  # noqa: F401
        import library.sdxl_model_util  # noqa: F401
        import networks.lora  # noqa: F401
        import sdxl_train_network  # noqa: F401

        report["sd_scripts_import"] = "ok"
    except Exception as exc:  # noqa: BLE001
        report["errors"].append(f"sd-scripts import failed: {exc!r}")

    report["ok"] = not report["errors"]
    print(f"[probe] {report}", flush=True)
    return report


# --- GPU training image -----------------------------------------------------
# Same base as the probe image, plus xformers (sd-scripts' well-trodden
# attention backend — sdpa also works but xformers is what most of the
# ecosystem's SDXL guidance/benchmarks assume), Pillow for the smoke test's
# synthetic dataset generation, and requests — REQUIRED by train_sdxl_lora_job's
# _patch_job / _refund_credits (both `import requests`); without it a
# failed/finished job silently never leaves
# "processing" in the UI, exactly the modal_lora_worker.py pitfall its own
# dispatch_image comment warns about.
train_image = image.pip_install("xformers==0.0.29.post3", "Pillow", "requests").env(
    {
        # Cache HF downloads (the ~7GB SDXL base checkpoint) on the persistent
        # Volume so repeated smoke-test runs don't re-download it every time.
        "HF_HOME": f"{MODELS_DIR}/hf_home_sdxl",
    }
)

SDXL_BASE_REPO = "stabilityai/stable-diffusion-xl-base-1.0"

# route.ts's LoRA preset dropdown (src/lib/loraModels.ts) is the SAME
# catalogue regardless of which worker actually trains the job — a user who
# picks "Illustrious XL" or "Juggernaut XL" must get a LoRA trained against
# THAT fine-tuned checkpoint, not a silent fallback to vanilla SDXL base.
# Mirrors modal_lora_worker.py's TARGET_MODELS entries for these two ids
# EXACTLY (same repo, same fp16-variant caveat) — kept as a separate copy
# per this worker's zero-runtime-coupling design (see the module docstring's
# CLAUDE.md §1 exception note), not imported.
#
# juggernaut_xl's mixed_precision override (2026-09-15, confirmed by reading
# sd-scripts' own loader source — library/sdxl_train_util.py
# _load_target_model, v0.11.1): for a HF repo id (not a local file), sd-scripts
# derives the Diffusers `variant` to load PURELY from weight_dtype
# (`variant = "fp16" if weight_dtype == torch.float16 else None`) — there is
# NO separate --variant CLI flag, and no automatic retry into the fp16
# variant when the initial (variant=None) load fails. RunDiffusion/
# Juggernaut-XL-v9 ships ONLY *.fp16.safetensors component files (no plain-
# variant weights — same fact ai-toolkit's own TARGET_MODELS comment
# recorded), so training it under this project's CLAUDE.md §1 BF16-standard
# would hard-crash at model load (EnvironmentError, file not found) — not a
# quality/speed tradeoff, a hard constraint of what the checkpoint publisher
# actually shipped. Forcing mixed_precision="fp16" for this ONE preset (with
# --no_half_vae, already unconditional in _build_train_args, for the VAE
# instability fp16 SDXL is known for) is the only way to load it at all.
#
# wai_illustrious（2026-09-21追加）は HF の Diffusers リポジトリが存在せず、
# Civitai 配布の単一 .safetensors しか無い。sd-scripts は
# --pretrained_model_name_or_path にローカルの単一チェックポイントを渡すのが
# 標準ワークフローなので（library/sdxl_train_util.py の _load_target_model は
# HF リポジトリIDとローカルファイルで分岐する）、Volume 上の実ファイルを
# そのまま指す。ファイルは admin のアップローダ（admin_upload_volume_file）か
# `modal volume put` で diffusion_models/ に置く。
# variant 導出は HF リポジトリID のときだけ効くので、単一ファイルでは
# mixed_precision はこのプロジェクト標準の bf16 のままでよい。
SDXL_TARGET_MODELS: dict[str, dict] = {
    "illustrious_xl": {"repo": "OnomaAIResearch/Illustrious-xl-early-release-v0"},
    "juggernaut_xl": {"repo": "RunDiffusion/Juggernaut-XL-v9", "mixed_precision": "fp16"},
    "wai_illustrious": {"repo": f"{MODELS_DIR}/diffusion_models/waiNSFW_illustrious_v11.safetensors"},
}


def _resolve_base_model(params: dict) -> tuple[str, str]:
    """Returns (pretrained_model_name_or_path, mixed_precision). `target_model`
    is the same preset id route.ts's LoRA dropdown sends for every arch
    (loraModels.ts) — "illustrious_xl" / "juggernaut_xl" map to their real
    fine-tuned checkpoints via SDXL_TARGET_MODELS above; target_model=="custom"
    (+ custom_model_id) is the universal loader (any HF repo id, or a bare
    filename resolved against the Volume, mirroring modal_lora_worker.py's
    own custom-model handling); anything else (missing / unrecognized, e.g. a
    direct API test) falls back to vanilla SDXL base at the project's default
    bf16."""
    target_model = str(params.get("target_model") or "").strip()
    if target_model == "custom":
        custom_id = str(params.get("custom_model_id") or "").strip()
        if custom_id:
            if "/" not in custom_id and not custom_id.startswith("http"):
                custom_id = f"{MODELS_DIR}/{custom_id}"
            return custom_id, "bf16"
    preset = SDXL_TARGET_MODELS.get(target_model)
    if preset:
        return str(preset["repo"]), str(preset.get("mixed_precision", "bf16"))
    return SDXL_BASE_REPO, "bf16"


# ULL Studio's LoRA caption pipeline (src/lib/loraCaptionSpec.ts,
# applySubjectFixedTags) always writes exactly 4 fixed leading tokens for a
# single-subject dataset: trigger, 1girl/1boy/1man/1woman, solo, female/male.
# A multi-subject (duo/group) dataset instead leads with N trigger tokens
# followed by N gender tokens (no shared solo/sex-word — see
# applySubjectFixedTags' group-shot branch), so its keep_tokens is 2*N, not a
# fixed 4. Callers that know the actual subject count should pass that
# instead of relying on this default.
DEFAULT_KEEP_TOKENS = 4

# ULL Studio's optimizer dropdown (LoraStudioTab.tsx OPTIMIZERS) uses
# lower-case ai-toolkit-style names; sd-scripts' --optimizer_type expects its
# own (differently-cased, "AdamW8bit" not "adamw8bit") class names. Mapping
# confirmed against sd-scripts' library/train_util.py optimizer factory.
SD_SCRIPTS_OPTIMIZER_MAP = {
    "adamw8bit": "AdamW8bit",
    "adamw": "AdamW",
    "prodigy": "Prodigy",
    "adafactor": "Adafactor",
    "lion8bit": "Lion8bit",
}

# 未知のオプティマイザ名が来たときのフォールバック。2026-09-20 に AdamW8bit
# から変更（ホスト判断）: 8bit 系（bitsandbytes の int8 量子化オプティマイザ）は
# UI の選択肢としては残すが、**どの既定経路でも黙って選ばれてはいけない**
# （CLAUDE.md §1 量子化は原則不使用・使うならホスト承認）。ユーザーが明示的に
# adamw8bit / lion8bit を選んだときだけ上の表を通って使われる。
SD_SCRIPTS_OPTIMIZER_FALLBACK = "AdamW"


def _write_dataset_toml(root: str, image_dir: str, resolution: int, keep_tokens: int = DEFAULT_KEEP_TOKENS) -> str:
    """Writes an sd-scripts "general method" dataset TOML pointing at an
    already-populated `image_dir` (each image alongside a same-stem `.txt`
    caption — exactly what ULL Studio's existing Smart Ingest + LoRA
    captioning pipeline already produces for the ai-toolkit worker). Returns
    the TOML path. `shuffle_caption`/`keep_tokens` mirror the project's
    keep_tokens=N caption convention (see DEFAULT_KEEP_TOKENS above)."""
    import pathlib

    toml_path = pathlib.Path(root) / "dataset.toml"
    toml_path.write_text(
        f"""\
[general]
shuffle_caption = true
caption_extension = '.txt'
keep_tokens = {int(keep_tokens)}

[[datasets]]
resolution = {int(resolution)}
batch_size = 1

  [[datasets.subsets]]
  image_dir = '{image_dir}'
  num_repeats = 1
""",
        encoding="utf-8",
    )
    return str(toml_path)


def _write_smoke_dataset(root: str, n: int = 5) -> str:
    """Generates `n` tiny synthetic images + keep_tokens=4-style captions
    under `root/images/`, and a matching sd-scripts dataset TOML via
    `_write_dataset_toml`. Returns the TOML path. Purely for proving the
    training pipeline runs end-to-end — real jobs get their dataset from the
    Next.js upload path instead."""
    import pathlib

    from PIL import Image

    img_dir = pathlib.Path(root) / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    for i in range(n):
        im = Image.new("RGB", (1024, 1024), (40 + i * 20, 80, 120))
        im.save(img_dir / f"{i:04d}.png")
        caption = "testchar, 1girl, solo, female, standing, simple background"
        (img_dir / f"{i:04d}.txt").write_text(caption, encoding="utf-8")

    # num_repeats=4 here (smoke test only, to get a few steps out of 5
    # images) — real datasets rely on _write_dataset_toml's default of 1
    # since real jobs already have enough images and a step count from `tc`.
    toml_path = pathlib.Path(root) / "dataset.toml"
    toml_path.write_text(
        f"""\
[general]
shuffle_caption = true
caption_extension = '.txt'
keep_tokens = {DEFAULT_KEEP_TOKENS}

[[datasets]]
resolution = 1024
batch_size = 1

  [[datasets.subsets]]
  image_dir = '{img_dir}'
  num_repeats = 4
""",
        encoding="utf-8",
    )
    return str(toml_path)


def _build_train_args(
    lora_name: str,
    dataset_toml: str,
    output_dir: str,
    tc: dict,
    resolution: int = 1024,
    pretrained_model: str = SDXL_BASE_REPO,
    mixed_precision: str = "bf16",
) -> list[str]:
    """The sd-scripts equivalent of modal_lora_worker.py's `_build_config()`
    — translates ULL Studio's job payload (`tc`: rank/alpha/learning_rate/
    steps/optimizer, same dict shape the ai-toolkit worker receives) into
    `sdxl_train_network.py` CLI args. No YAML job file — sd-scripts is
    CLI/TOML-driven, so the "config" here IS this arg list plus the dataset
    TOML `_write_dataset_toml` already wrote.

    Mirrors `_build_config`'s param semantics 1:1 so route.ts's existing
    training_config payload needs no shape change to target this worker:
      rank/alpha        -> network_dim/network_alpha
      steps              -> max_train_steps
      optimizer/learning_rate -> optimizer_type/learning_rate (prodigy forces
                           lr=1.0, exactly like _build_config — Prodigy is a
                           learning-rate-FREE optimizer everywhere, not just
                           in ai-toolkit)
      resolution         -> clamped to sd-scripts' SDXL-supported buckets
      (actual resolution is baked into the dataset TOML by
      `_write_dataset_toml`, not a CLI arg here — `res` below is only used
      for the log line, to confirm what the caller asked for)

    pretrained_model / mixed_precision: caller resolves these via
    _resolve_base_model(params) — see that function's docstring for why
    they're NOT hardcoded (illustrious_xl / juggernaut_xl need their own
    checkpoint + juggernaut's fp16-only-repo mixed_precision override).
    """
    rank = int(tc.get("rank", DEFAULT_TRAINING_CONFIG["rank"]))
    alpha = int(tc.get("alpha", DEFAULT_TRAINING_CONFIG["alpha"]))
    steps = int(tc.get("steps", DEFAULT_TRAINING_CONFIG["steps"]))
    optimizer_key = str(tc.get("optimizer", DEFAULT_TRAINING_CONFIG["optimizer"])).lower()
    optimizer_type = SD_SCRIPTS_OPTIMIZER_MAP.get(optimizer_key, SD_SCRIPTS_OPTIMIZER_FALLBACK)
    if optimizer_key == "prodigy":
        # Same rationale as modal_lora_worker.py's _build_config: Prodigy
        # self-estimates step size and treats `lr` as a multiplier on that
        # estimate — the AdamW-scale value the GUI's LR slider means (1e-5〜
        # 2e-4) would cripple it. Force the universal Prodigy convention.
        lr = 1.0
    else:
        lr = float(tc.get("learning_rate", DEFAULT_TRAINING_CONFIG["learning_rate"]))
    # Same cadence rule as _build_config: every 500 steps, or every 25% for
    # short runs, so the user can pick the least over-fit checkpoint.
    save_every = min(250, max(100, steps // 4))
    # 2026-09-20: 刻みを 500 → 250 に細かくし、代わりに **保存回数を20回で頭打ち**
    # にする（ホスト判断「500は広すぎる。当たりがどこか分からないし、ベストが
    # 欲しくて刻みたい人はいる」）。ai-toolkit 側の max_step_saves_to_keep=20 と
    # 同じ数に揃えてある。
    #
    # 容量: rank64 MiniMax H3 は1個1.2GB なので最大 21個 ≒ 25GB/ジョブ。Modal の
    # Volume は 1TiB/月まで無料、超過分は $0.09/GiB/月 なので、14日保持だと
    # 最悪でも約 $0.84（¥125）/ジョブ。刻みを細かくする価値の方が大きいと判断した。
    # ⚠️ ただし Volume(v1) は **ファイル数** に上限がある（推奨5万・ハード50万
    # inode、超えると attach 遅延が線形に伸びる）。効いてくるならバイト数より先に
    # こちらなので、増やす方向に触るときはファイル数を確認すること。
    if steps > 5000:
        save_every = ((steps + 999) // 1000) * 50
    res = resolution if resolution in (512, 768, 1024, 1280) else 1024

    args = [
        f"--pretrained_model_name_or_path={pretrained_model}",
        f"--dataset_config={dataset_toml}",
        f"--output_dir={output_dir}",
        f"--output_name={lora_name}",
        "--save_model_as=safetensors",
        "--network_module=networks.lora",
        f"--network_dim={rank}",
        f"--network_alpha={alpha}",
        f"--optimizer_type={optimizer_type}",
        f"--learning_rate={lr}",
        f"--max_train_steps={steps}",
        f"--save_every_n_steps={save_every}",
        f"--mixed_precision={mixed_precision}",
        # The DELIVERED LoRA's own weight dtype — independent of
        # mixed_precision (which only controls how the base checkpoint is
        # loaded/trained against, forced to fp16 for the odd fp16-only-repo
        # preset above). Stays this project's bf16 standard regardless.
        "--save_precision=bf16",
        "--cache_latents",
        "--sdpa",
        "--min_snr_gamma=5",
        "--seed=42",
        "--no_half_vae",
    ]
    # 2026-09-20: --gradient_checkpointing を既定で外した（ホスト判断、
    # modal_lora_worker.py の LORA_GRADIENT_CHECKPOINTING と同じ理由 — VRAM を
    # 節約して速度を捨てる設定は使わない）。
    # ⚠️ ただしこのワーカーだけは GPU_REQUEST が L40S(48GB) で、ai-toolkit 側の
    # Blackwell(288GB) と違って余裕が薄い。1024px/batch1 の SDXL LoRA なら
    # 収まる見込みだが **未検証**。OOM が出たら SDXL_GRADIENT_CHECKPOINTING=1 で
    # 即座に従来挙動へ戻せる（この経路だけ env の逃げ道を残しているのはそのため）。
    # 本筋は modal_lora_benchmark.py で L40S の peak VRAM を実測してから確定する。
    if SDXL_GRADIENT_CHECKPOINTING:
        args.append("--gradient_checkpointing")
    if optimizer_key == "prodigy":
        # sd-scripts' own Prodigy guidance (README / --help): decouple +
        # safeguard_warmup is the standard pairing, same as most Prodigy
        # integrations outside ai-toolkit too. --optimizer_args takes
        # multiple bare key=value tokens after ONE flag (argparse
        # nargs="+") — this is a literal argv list (subprocess.run, no
        # shell), so no quote characters belong in the tokens themselves.
        args += ["--optimizer_args", "decouple=True", "weight_decay=0.01", "safeguard_warmup=True"]
    print(
        f"[sdxl] built train args -> {lora_name}: {steps} steps, rank {rank}/{alpha}, "
        f"{optimizer_type}@lr={lr}, {res}px, save_every={save_every}",
        flush=True,
    )
    return args


# Same defaults the ai-toolkit worker falls back to (modal_lora_worker.py
# DEFAULT_TRAINING_CONFIG) when route.ts's payload omits a field — kept as a
# separate copy rather than importing modal_lora_worker.py, since these two
# workers intentionally have zero runtime coupling (CLAUDE.md §1 exception
# note: independent images, independent trainers).
DEFAULT_TRAINING_CONFIG = {
    "rank": 32,
    "alpha": 16,
    "learning_rate": 1e-4,
    "steps": 2000,
    "optimizer": "prodigy",
}


@app.function(image=train_image, gpu=GPU_REQUEST, volumes={MODELS_DIR: vol}, timeout=3600)
def smoke_test_sdxl_lora(
    steps: int = 20,
    rank: int = 16,
    resolution: int = 1024,
    images: int = 5,
    target_model: str = "",
) -> dict:
    """Minimal REAL end-to-end proof: tiny synthetic dataset -> a handful of
    training steps -> a valid .safetensors LoRA out the other end, on the
    actual chosen GPU tier (L40S by default). Not a production job — no
    dataset upload contract, no job persistence, no pricing. Just answers
    "does the pipeline actually work on this GPU" before any of that gets
    built (CLAUDE.md §0 — measure before committing to a design)."""
    import glob
    import pathlib
    import subprocess
    import sys
    import threading
    import time

    sys.path.insert(0, SD_SCRIPTS_DIR)

    work = pathlib.Path("/root/smoke")
    work.mkdir(parents=True, exist_ok=True)
    dataset_toml = _write_smoke_dataset(str(work), n=images)
    output_dir = work / "output"
    output_dir.mkdir(exist_ok=True)

    # Exercises the REAL _build_config-equivalent (rank 16/alpha 8, 20 steps,
    # 1024px) rather than a separately hand-maintained arg list, so this smoke
    # test also proves _build_train_args itself works.
    #
    # 2026-09-20: optimizer を adamw8bit から本番既定の prodigy へ変更。
    # スモークは「本番と同じ設定が通ること」を確かめるものなので、本番が使わない
    # 量子化オプティマイザで測っていては意味がない。
    # ⚠️ さらに重要: costGuard.server.ts / loraRuntime.ts の
    # LORA_SPI_BASELINE["sdxl"] = 1.4 は、**このスモークを旧設定
    # （AdamW8bit + gradient_checkpointing 有効）で回したときの 1.32s/it** が
    # 出所だった。どちらも既定から外れたので、あの値はもう本番条件を表して
    # いない。modal_lora_benchmark.py で測り直すまで暫定値として扱うこと。
    # 2026-09-20: steps/rank/resolution/images を引数化した。値付けのために
    # 「prep（枚数・step数に依らない固定費）」と「s/it」を分離する必要があり、
    # step 数だけ変えた2回の実行の差分から解くのが一番確実なため:
    #   elapsed(N1) = prep + N1 × spi
    #   elapsed(N2) = prep + N2 × spi
    tc = {
        "rank": rank,
        "alpha": max(1, rank // 2),
        "steps": steps,
        "optimizer": "prodigy",
        "learning_rate": 1e-4,
    }
    # 2026-09-21: target_model を引数化した。既定（空文字）は従来どおりバニラ
    # SDXL base だが、プリセット id を渡せばそのベースで通るかを確かめられる。
    # 特に wai_illustrious は **HF リポジトリIDではなく Volume 上の単一
    # .safetensors** を渡す初のケースで、sd-scripts のローカルファイル分岐を
    # 実機で通したことが無かった（本番ジョブを流す前にここで潰す）。
    pretrained_model, mixed_precision = _resolve_base_model({"target_model": target_model})
    print(f"[smoke] base model -> {pretrained_model} (mixed_precision={mixed_precision})", flush=True)
    args = [sys.executable, f"{SD_SCRIPTS_DIR}/sdxl_train_network.py"] + _build_train_args(
        "smoke_test",
        dataset_toml,
        str(output_dir),
        tc,
        resolution=resolution,
        pretrained_model=pretrained_model,
        mixed_precision=mixed_precision,
    )

    # gradient_checkpointing を既定OFFにした（2026-09-20）影響で、L40S(48GB)
    # に収まるかが未検証。peak VRAM を必ず記録する。
    vram: list[float] = []
    stop_evt = threading.Event()

    def _sample_vram() -> None:
        while not stop_evt.is_set():
            try:
                out = subprocess.run(
                    ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=10,
                )
                mb = sum(float(x.strip()) for x in out.stdout.split() if x.strip())
                vram.append(mb / 1024.0)
            except Exception:
                pass
            stop_evt.wait(5.0)

    sampler = threading.Thread(target=_sample_vram, daemon=True)
    sampler.start()

    # CLAUDE.md §1: subprocess の標準出力は溜め込まず1行ずつ流す。
    # capture_output=True だと crash-loop の早期発見（「最初の数分でログを
    # 確認する」）が原理的に不可能になる。
    t0 = time.time()
    proc = subprocess.Popen(
        args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    tail: list[str] = []
    for line in proc.stdout:  # type: ignore[union-attr]
        line = line.rstrip("\n")
        print(line, flush=True)
        tail.append(line)
        if len(tail) > 80:
            tail.pop(0)
    returncode = proc.wait()
    elapsed = time.time() - t0
    stop_evt.set()
    sampler.join(timeout=15)

    result: dict = {
        "returncode": returncode,
        "elapsed_s": round(elapsed, 1),
        "steps": steps,
        "rank": rank,
        "resolution": resolution,
        "images": images,
        "gpu": GPU_REQUEST,
        "target_model": target_model or "(vanilla sdxl base)",
        "pretrained_model": pretrained_model,
        "mixed_precision": mixed_precision,
        "gradient_checkpointing": SDXL_GRADIENT_CHECKPOINTING,
        "vram_peak_gb": round(max(vram), 2) if vram else None,
        "vram_samples": len(vram),
        "tail": tail[-25:] if returncode != 0 else None,
    }
    produced = glob.glob(str(output_dir / "*.safetensors"))
    result["produced_files"] = produced
    if produced:
        from safetensors import safe_open

        with safe_open(produced[0], framework="pt") as f:
            keys = list(f.keys())
        result["tensor_count"] = len(keys)
        result["has_lora_keys"] = any("lora" in k.lower() for k in keys)
        result["file_size_mb"] = round(pathlib.Path(produced[0]).stat().st_size / 1e6, 2)
    print(f"[smoke] RESULT: {result}", flush=True)
    return result


# ---------------------------------------------------------------------------
# Production job plumbing — Supabase job rows, credits refund, Storage
# download, VRAM telemetry. Duplicated from modal_lora_worker.py's own
# copies (identical, generic HTTP/Supabase logic with zero ai-toolkit
# coupling) rather than imported: the two workers are meant to have zero
# runtime coupling (CLAUDE.md §1 exception note — independent images,
# independent trainers, a crash-loop in one must never affect the other).
# ---------------------------------------------------------------------------
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
# Same Volume (ull-wan-models) AND same path convention as modal_lora_worker.py
# for both of these — so a job's `ingest_dir` (Smart Ingest's CPU-optimized
# images) and the checkpoint-download signed-URL endpoint (which serves
# loras/<user_id>/<job_id>/<filename> off this Volume) both work UNCHANGED
# for this worker's output, with no route.ts or download-endpoint changes.
PERSIST_ROOT = f"{MODELS_DIR}/datasets"
LORA_OUTPUT_DIR = f"{MODELS_DIR}/loras"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _current_effective_vram_gb():
    """CLAUDE.md §6 Active VRAM telemetry — no denominator / GPU model name
    (spoiler-free 'Active VRAM' badge, CLAUDE.md §2). None off-GPU."""
    try:
        import torch

        if torch.cuda.is_available():
            free_b, total_b = torch.cuda.mem_get_info()
            return round((total_b - free_b) / (1024**3), 1)
    except Exception:  # noqa: BLE001 — telemetry only, never fatal
        pass
    return None


def _supabase_request(method: str, path: str, **kwargs):
    import requests

    supabase_url = os.environ.get("SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_key:
        print("[sdxl-worker] Supabase env not configured, skipping request.")
        return None
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    return requests.request(method, f"{supabase_url}{path}", headers=headers, timeout=10, **kwargs)


class InfraError(RuntimeError):
    """A transient infra failure (network/Storage) — always refunded."""


class SafetyLimitError(RuntimeError):
    """原価割れ防止のためにシステム側の判断で早期停止した、という区別。
    modal_lora_worker.py の同名クラスと同じ契約: 中間チェックポイントは
    Volume に残して salvage 可能にし、クレジットは **全額返金** する
    （ユーザーの設定ミスによるクラッシュではないため）。"""

    def __init__(self, message: str, *, kind: str = "cost", checkpoints: "list | None" = None):
        super().__init__(message)
        self.kind = kind
        # 停止時点までに保全できたチェックポイント。job 行の metadata へ載せて
        # ダウンロード API（filename の許可リストとして metadata.checkpoints を
        # 見る）から引けるようにする。
        self.checkpoints = checkpoints or []


def _trimmed_spi(hist) -> "float | None":
    """直近 ~30 step の s/it を trimmed 平均で出す。上下 15% を落とすので、
    チェックポイント保存で1 step だけ跳ねた区間や、逆に cache ヒットで
    速すぎた区間に予測が引きずられない。modal_lora_worker.py の同名関数と
    同じ実装（2つのワーカーは意図的に無結合なので import せず複製）。"""
    xs = list(hist)
    if len(xs) < 5:
        return None
    last_step = xs[-1][1]
    xs = [p for p in xs if last_step - p[1] <= 30] or xs
    ivs: list[float] = []
    for (t0, s0), (t1, s1) in zip(xs, xs[1:]):
        ds = s1 - s0
        if ds > 0:
            ivs.append((t1 - t0) / ds)
    if len(ivs) < 3:
        return None
    ivs.sort()
    k = max(1, int(len(ivs) * 0.15))
    core = ivs[k:-k] if len(ivs) > 2 * k else ivs
    return (sum(core) / len(core)) if core else None


def _credit_covered_seconds(credits_cost: int) -> int:
    """支払われたクレジットが目標マージンを保ったまま賄える GPU 秒。

      revenue_jpy  = credits_cost x SDXL_CREDIT_TO_JPY
      max_cost_jpy = revenue_jpy x SDXL_MARGIN_TARGET
      L40S         = SDXL_GPU_USD_PER_HOUR x SDXL_USD_JPY 円/h

    ⚠️ ai-toolkit 側は B300 の時間単価で割るが、このワーカーは L40S で回る
    （単価が約 1/4）。同じ式を流用すると許容秒が 1/4 になり、正常なジョブを
    誤って撃ち落とす。課金側も arch=sdxl だけ別単価 knob
    （lora_credits_per_gpu_second_sdxl）を使っているので、損切り側も GPU tier を
    合わせる必要がある。これはあくまで payload が無いときのフォールバックで、
    本筋は costGuard.server.ts が渡してくる cost_cap_seconds。
    """
    revenue_jpy = max(0, credits_cost) * SDXL_CREDIT_TO_JPY
    max_cost_jpy = revenue_jpy * SDXL_MARGIN_TARGET
    jpy_per_sec = (SDXL_GPU_USD_PER_HOUR * SDXL_USD_JPY) / 3600
    secs = max_cost_jpy / jpy_per_sec if jpy_per_sec > 0 else 0.0
    return int(max(1800, min(secs, SDXL_ABS_MAX_RUN_S)))


def _expected_run_floor_seconds(total_steps: int) -> int:
    """損切りの下限。いくら課金額が小さくても、宣言した step 数を基準 s/it で
    走り切るだけの時間（+30% と prep 余裕）は必ず与える。CLAUDE.md §0
    「タイムアウト／ポーリング上限は多めに」。"""
    if total_steps <= 0:
        return 0
    floor = SDXL_FLOOR_PREP_S + total_steps * SDXL_SPI_BASELINE * 1.3
    return int(min(floor, SDXL_ABS_MAX_RUN_S))


def _cost_cap_seconds(credits_cost: int, total_steps: int, override_s: int = 0) -> tuple[int, str]:
    """このジョブに許す実時間の上限（秒）と、ログ用の理由文字列。

    override_s > 0（= Next.js が pricing_knobs から算出して payload
    cost_cap_seconds で渡してきた値）ならそれをそのまま使う。admin で単価や
    閾値を変えたとき worker を再デプロイせずに追従させるため。"""
    if override_s > 0:
        capped = int(min(override_s, SDXL_ABS_MAX_RUN_S))
        return capped, f"payload cost_cap_seconds={override_s}s -> {capped}s ({capped / 3600:.2f}h)"
    base = _credit_covered_seconds(credits_cost) if credits_cost > 0 else SDXL_SAFETY_LIMIT_S
    with_margin = base * SDXL_COST_GUARD_MULTIPLIER
    floor = _expected_run_floor_seconds(total_steps)
    capped = int(min(max(with_margin, floor), SDXL_ABS_MAX_RUN_S))
    reason = (
        f"{credits_cost}C -> base {base}s x{SDXL_COST_GUARD_MULTIPLIER:.2f} = {int(with_margin)}s, "
        f"floor[{total_steps or '?'}st @ {SDXL_SPI_BASELINE}s/it] {floor}s -> {capped}s "
        f"({capped / 3600:.2f}h)"
    )
    return capped, reason


_INFRA_MSG_RE = re.compile(
    r"(read timed out|connect timed out|connection (?:reset|aborted|error|refused)|"
    r"connectionpool|max retries exceeded|failed to establish a new connection|"
    r"temporarily unavailable|name or service not known|"
    r"no space left on device|502 bad gateway|\b50[234]\b)",
    re.IGNORECASE,
)


def _is_infra_error(exc: BaseException) -> bool:
    if isinstance(exc, (InfraError, ConnectionError)):
        return True
    name = type(exc).__name__
    if name in ("ConnectionError", "Timeout", "ReadTimeout", "ConnectTimeout", "ChunkedEncodingError"):
        return True
    return bool(_INFRA_MSG_RE.search(str(exc)))


# 2026-09-19: 学習用データセット画像のアップロード先を Supabase Storage
# ("lora_datasets" バケット) から Modal Volume 直配信へ移行（CLAUDE.md §1
# 標準）。アップロード自体は modal_lora_worker.py::upload_lora_dataset_image
# （このワーカーとは別appだが同じ Volume "ull-wan-models" を共有）が受け
# 持つので、ここでは書き込み先と同じ規約でVolumeから直接読むだけでよい。
LORA_DATASET_UPLOADS_DIR = f"{MODELS_DIR}/lora_dataset_uploads"


def _read_lora_dataset_upload(key: str) -> bytes:
    """"<user_id>/<dataset_id>/<filename>" 形式のkeyでVolumeから直接読む。"""
    if ".." in key:
        raise ValueError(f"illegal storage key: {key!r}")
    p = pathlib.Path(LORA_DATASET_UPLOADS_DIR) / key
    if not p.is_file():
        raise RuntimeError(f"dataset upload not found on Volume: {key}")
    return p.read_bytes()


def _patch_job(job_id: str, fields: dict) -> None:
    if not job_id:
        return

    def _send(payload: dict):
        return _supabase_request(
            "PATCH",
            "/rest/v1/generation_jobs",
            params={"id": f"eq.{job_id}"},
            json={**payload, "updated_at": _now_iso()},
            headers={"Prefer": "return=minimal"},
        )

    attempts, backoff_s = 3, 0.6
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            res = _send(fields)
            if res is not None and res.ok:
                return
            if res is not None and res.status_code >= 400 and "metadata" in fields:
                body = (res.text or "").lower()
                if "metadata" in body or "schema cache" in body or "column" in body:
                    slim = {k: v for k, v in fields.items() if k != "metadata"}
                    res2 = _send(slim) if slim else None
                    if res2 is not None and res2.ok:
                        print(f"[sdxl-worker] job {job_id}: 'metadata' column absent — patched without it")
                        return
                    last_exc = RuntimeError("metadata column absent and slim patch also failed")
                    break
            last_exc = RuntimeError(
                f"HTTP {res.status_code}: {res.text[:300]}" if res is not None else "no response (env not configured)"
            )
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
        if attempt < attempts:
            time.sleep(backoff_s * attempt)
    print(f"[sdxl-worker] failed to update job {job_id} (after retries): {last_exc}")


def _claim_job(job_id: str, fields: dict) -> bool:
    """Conditional 'queued' -> 'processing' claim. False means the row is no
    longer 'queued' (cancelled / superseded) — abort without touching the GPU."""
    if not job_id:
        return True
    try:
        res = _supabase_request(
            "PATCH",
            "/rest/v1/generation_jobs",
            params={"id": f"eq.{job_id}", "status": "eq.queued"},
            json={**fields, "updated_at": _now_iso()},
            headers={"Prefer": "return=representation"},
        )
        if res is None:
            return True  # Supabase not configured — local CLI path
        rows = res.json()
        return bool(rows)
    except Exception as exc:  # noqa: BLE001
        print(f"[sdxl-worker] job claim check failed for {job_id} (continuing): {exc}")
        return True


def _refund_credits(user_id: str, amount: int) -> None:
    if not user_id or not amount or amount <= 0:
        return
    try:
        res = _supabase_request("GET", "/rest/v1/profiles", params={"id": f"eq.{user_id}", "select": "credits"})
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
    except Exception as exc:  # noqa: BLE001 — best-effort
        print(f"[sdxl-worker] failed to refund {amount} credits to {user_id}: {exc}")


def _derive_trigger(params: dict, lora_name: str) -> str:
    supplied = str(params.get("trigger_word") or "").strip()
    if supplied:
        return supplied
    m = re.match(r"[A-Za-z0-9]+", lora_name)
    return m.group(0) if m else lora_name


def _job_output_dir(run_key: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", str(run_key or "")).strip("_")[:120] or "job"
    return f"{MODELS_DIR}/outputs_sdxl/{safe}"


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
# Metadata-tag embedding — the ORIGINAL motivating ask for this whole worker
# (host, 2026-09-15: "主要タグだと出てこない特徴を埋め込みたい"). Ported from
# the host's own standalone tool, D:\coconala\副業ラッコ平丸\NTR校長キャラ\
# lora_duo\fix_lora_metadata_gui.py (`clean_tag_frequency` / `clean_tag_list`
# / `parse_tags_arg` / the metadata half of `process_file`) — same logic,
# applied in-process right after training instead of as a manual post-hoc
# GUI step. Deliberately OPT-IN: a job with no `embed_tags` param leaves
# sd-scripts' own native ss_tag_frequency (real per-tag counts from the
# actual captions) completely untouched. This is for the opposite case — the
# host wants to REPLACE that with a small, curated, human-picked tag set
# (trigger + a few characteristic traits invisible in the main captions) so
# that's what shows up in ComfyUI/Civitai/A1111's "trained words" UI instead
# of hundreds of noisy auto-tags.
# ---------------------------------------------------------------------------
_EMBED_TAG_FREQ_KEYS = ("ss_tag_frequency",)
_EMBED_TAG_LIST_KEYS = ("modelspec.tags", "ss_metadata_tags")
_EMBED_TRAINED_WORDS_KEY = "ss_trained_words"
# The reference tool's own default — a dummy value with no real statistical
# meaning (not an actual occurrence count); kept identical so a LoRA touched
# by either tool looks the same to any downstream reader.
EMBED_TAG_DEFAULT_FREQ = 21


class TagParseError(ValueError):
    pass


def _parse_embed_tags(raw: str, default_freq: int = EMBED_TAG_DEFAULT_FREQ) -> dict:
    """"tag:freq,tag:freq,..." or plain "tag,tag,..." -> {tag: freq}. Same
    format/behavior as the reference tool's parse_tags_arg, so a host used
    to typing tags into that GUI can type the exact same string here."""
    tags: dict[str, int] = {}
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" in chunk:
            name, _, freq = chunk.rpartition(":")
            name = name.strip()
            try:
                tags[name] = int(freq.strip())
            except ValueError:
                raise TagParseError(f"タグの頻度が数値ではありません: '{chunk}'")
        else:
            tags[chunk] = default_freq
    if not tags:
        raise TagParseError("有効なタグが指定されていません")
    return tags


def _clean_tag_frequency(raw_json: str, target_tags: dict) -> str:
    """Rebuilds a kohya-ss ss_tag_frequency blob to contain ONLY target_tags.

    Must stay a 2-level nested dict ({"<bucket>": {tag: freq}}) — any reader
    (this project's own ComfyUI custom nodes included, per the reference
    tool's comment) that expects that shape breaks on a flat {tag: freq}."""
    try:
        data = json.loads(raw_json)
    except (json.JSONDecodeError, TypeError):
        data = None
    if isinstance(data, dict) and data and all(isinstance(v, dict) for v in data.values()):
        new_data = {bucket: dict(target_tags) for bucket in data.keys()}
    else:
        new_data = {"dataset": dict(target_tags)}
    return json.dumps(new_data, ensure_ascii=False)


def _clean_tag_list(raw: str, target_tags: dict) -> str:
    """Rebuilds a tag-list metadata string (JSON array / JSON dict / CSV) to
    contain ONLY target_tags, preserving whichever of those 3 shapes it
    already had."""
    tags = list(target_tags.keys())
    stripped = raw.strip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list):
            return json.dumps(tags, ensure_ascii=False)
        if isinstance(parsed, dict):
            return json.dumps({t: target_tags[t] for t in tags}, ensure_ascii=False)
    return ", ".join(tags)


def _embed_metadata_tags(safetensors_path: str, target_tags: dict) -> list[str]:
    """In-place rewrite of a .safetensors' metadata to surface ONLY
    `target_tags` as its "trained words" (ss_tag_frequency / modelspec.tags /
    ss_metadata_tags where already present, ss_trained_words always). Returns
    the list of metadata keys actually changed. No-ops (returns []) if
    target_tags is empty — callers should treat that as "skip entirely",
    never call this with an empty dict expecting a no-op-but-logged path."""
    if not target_tags:
        return []
    from safetensors import safe_open
    from safetensors.torch import save_file

    with safe_open(safetensors_path, framework="pt") as f:
        metadata = dict(f.metadata() or {})
        tensors = {key: f.get_tensor(key) for key in f.keys()}

    changed_keys: list[str] = []
    for key in _EMBED_TAG_FREQ_KEYS:
        if key in metadata:
            metadata[key] = _clean_tag_frequency(metadata[key], target_tags)
            changed_keys.append(key)
    for key in _EMBED_TAG_LIST_KEYS:
        if key in metadata:
            metadata[key] = _clean_tag_list(metadata[key], target_tags)
            changed_keys.append(key)
    # ComfyUI's own "trained words" fallback reader — set unconditionally
    # (existing or not), same as the reference tool.
    metadata[_EMBED_TRAINED_WORDS_KEY] = ", ".join(target_tags.keys())
    changed_keys.append(_EMBED_TRAINED_WORDS_KEY)

    save_file(tensors, safetensors_path, metadata=metadata)
    return changed_keys


# --- 派生モデルのライセンス表示（2026-09-21）-------------------------------
# Illustrious 系（Illustrious XL 本家と、WAI 等のマージ派生）は Fair AI Public
# License 1.0-SD。同ライセンスは "To 'modify' also means to perform any training
# on a model" と定義しており、**このベースで焼いた LoRA は「出力物」ではなく
# 「派生モデル」** にあたる。したがって Notices 条項
# （"all modifications must be provided under this license"）が LoRA 本体にも
# かかる。
#
# ⚠️ 生成された「画像」は別扱いで、Outputs 条項
# （"The output of this software is not covered by this license"）により
# ライセンスの対象外＝自由。混同しないこと。
#
# 利用規約 第3条の2 でサービスとしての告知は済ませてあるが、**ファイル単体で
# 配られた後も表示が残るように**、ここで2か所に焼き込む:
#   1. .safetensors の metadata（modelspec.license / ss_ull_license）
#      — Civitai や ComfyUI へ持ち出されても付いて回る
#   2. 同梱の LICENSE.txt — 一括DLのZIPに入る
# 判定の根拠は docs/model-licenses.md。
FAIPL_LICENSE = {
    "name": "Fair AI Public License 1.0-SD",
    "url": "https://freedevproject.org/faipl-1.0-sd/",
}
# ベースモデルごとのライセンス。ここに無い arch/preset は何も焼き込まない
# （誤った表示を付ける方が害が大きい）。
# base_label は納品物（metadata / LICENSE.txt）に載るので、Volume の内部パスでは
# なく人が読める名前にする。
_PRESET_LICENSE: dict[str, dict] = {
    "illustrious_xl": {**FAIPL_LICENSE, "base_label": "Illustrious XL"},
    "wai_illustrious": {**FAIPL_LICENSE, "base_label": "WAI NSFW Illustrious v11"},
}


def _license_for(params: dict) -> dict | None:
    return _PRESET_LICENSE.get(str(params.get("target_model") or "").strip())


def _stamp_license_metadata(safetensors_path: str, license_info: dict, base_label: str) -> list[str]:
    """.safetensors の metadata にライセンス表記を書き込む。テンソル本体は
    一切触らない（_embed_metadata_tags と同じ save_file 経由の書き戻し）。
    失敗しても学習結果を落とさないこと — 呼び出し側で握りつぶす。"""
    from safetensors import safe_open
    from safetensors.torch import save_file

    with safe_open(safetensors_path, framework="pt") as f:
        metadata = dict(f.metadata() or {})
        tensors = {key: f.get_tensor(key) for key in f.keys()}

    stamped = {
        # modelspec.* は sd-scripts / ComfyUI / Civitai が読む標準キー。
        "modelspec.license": license_info["name"],
        "ss_ull_license": license_info["name"],
        "ss_ull_license_url": license_info["url"],
        "ss_ull_base_model": base_label,
    }
    metadata.update(stamped)
    save_file(tensors, safetensors_path, metadata=metadata)
    return list(stamped)


def _write_license_file(job_dir: pathlib.Path, license_info: dict, base_label: str, lora_name: str) -> None:
    """一括DL の ZIP に入る LICENSE.txt。ファイル単体で人に渡ったときに
    「何のライセンスか」が読めるようにするためのもの。"""
    lines = [
        f"{lora_name}.safetensors",
        "",
        "このLoRAは次のベースモデルを学習して作られた派生モデルです:",
        f"  {base_label}",
        "",
        f"ベースモデルのライセンス: {license_info['name']}",
        f"  {license_info['url']}",
        "",
        "同ライセンスは「モデルに対して学習を行うこと」を改変と定義しており、",
        "その結果であるこのLoRAも同ライセンス（または同等以上に寛容な条件）の",
        "もとで提供されます。再配布する場合も同じ条件で提供してください。",
        "",
        "なお、このLoRAを使って生成した画像そのものは同ライセンスの対象外です",
        "（The output of this software is not covered by this license.）。",
        "",
    ]
    (job_dir / "LICENSE.txt").write_text(chr(10).join(lines), encoding="utf-8")


def _stage_dataset(params: dict, dataset_dir: pathlib.Path, trigger: str) -> list[pathlib.Path]:
    """Materialises training images + same-stem .txt captions into
    `dataset_dir`. Mirrors modal_lora_worker.py's train_lora_job staging
    block (ingest_dir Smart Ingest fast-path -> storage_paths ->  inline
    images) MINUS the local-VLM captioning fallback: this worker's captions
    always arrive pre-filled from the cloud vision API (module docstring —
    ULL Studio's SDXL flow only ever uses this worker for training, never
    captioning), so a blank caption here just becomes the trigger word,
    never a 27B VLM load."""
    dataset_dir.mkdir(parents=True, exist_ok=True)
    image_paths: list[pathlib.Path] = []
    storage_paths = params.get("storage_paths") or []

    ingest_rel = str(params.get("ingest_dir") or "").strip().strip("/")
    staged_from_ingest = False
    if ingest_rel and ".." not in ingest_rel:
        try:
            vol.reload()
        except Exception:  # noqa: BLE001
            pass
        ingest_src = pathlib.Path(PERSIST_ROOT) / ingest_rel
        if ingest_src.is_dir():
            found = sorted(
                p
                for p in ingest_src.iterdir()
                if p.is_file() and p.stat().st_size > 0 and p.suffix.lower() in IMAGE_EXTS
            )
            if found and (not storage_paths or len(found) == len(storage_paths)):
                for i, src in enumerate(found):
                    dest = dataset_dir / f"{i:04d}{src.suffix.lower()}"
                    shutil.copy2(src, dest)
                    image_paths.append(dest)
                staged_from_ingest = True
                print(
                    f"[sdxl] staged {len(image_paths)} pre-optimized images from {ingest_src} "
                    "(Smart Ingest — no Supabase download)",
                    flush=True,
                )

    if not staged_from_ingest:
        if storage_paths:
            for i, key in enumerate(storage_paths):
                data = _read_lora_dataset_upload(str(key))
                ext = os.path.splitext(str(key))[1] or ".png"
                dest = dataset_dir / f"{i:04d}{ext}"
                dest.write_bytes(data)
                image_paths.append(dest)
        else:
            for i, item in enumerate(params.get("images") or []):
                if isinstance(item, str):
                    item = {"path": item}
                if item.get("path"):
                    src = pathlib.Path(item["path"])
                    if not src.is_absolute():
                        src = pathlib.Path(MODELS_DIR) / item["path"]
                    if not src.exists():
                        raise FileNotFoundError(f"image path not on Volume: {src}")
                    dest = dataset_dir / f"{i:04d}_{src.name}"
                    shutil.copy2(src, dest)
                else:
                    name = os.path.basename(item.get("filename") or "img.png")
                    dest = dataset_dir / f"{i:04d}_{name}"
                    dest.write_bytes(base64.b64decode(item["data"]))
                image_paths.append(dest)
    image_paths.sort()  # the 4-digit prefix keeps this in caption order
    if not image_paths:
        raise ValueError("no images supplied")

    supplied = list(params.get("captions") or [])
    custom_captions = params.get("custom_captions")

    def _custom_caption_for(idx: int, p: pathlib.Path) -> str:
        cc = custom_captions
        if isinstance(cc, list):
            v = cc[idx] if idx < len(cc) else ""
            return str(v).strip() if v else ""
        if isinstance(cc, dict):
            stem = p.stem
            bare = stem.split("_", 1)[-1] if "_" in stem else stem
            for k in (str(idx), f"{idx:04d}", stem, p.name, bare):
                if cc.get(k):
                    return str(cc[k]).strip()
        return ""

    for idx, path in enumerate(image_paths):
        cap = _custom_caption_for(idx, path)
        if not cap and idx < len(supplied):
            cap = (supplied[idx] or "").strip()
        path.with_suffix(".txt").write_text(cap or trigger, encoding="utf-8")

    print(f"[sdxl] staged {len(image_paths)} images + captions for training", flush=True)
    return image_paths


_SDXL_STEP_RE = re.compile(r"steps:\s*\d+%\|.*?\|\s*(\d+)/(\d+)")
# sd-scripts が --save_every_n_steps で吐く中間チェックポイントのファイル名
# （"<output_name>-step00000250.safetensors"）から step 数を取る。最終保存は
# サフィックス無しの "<output_name>.safetensors"。
_SDXL_CKPT_STEP_RE = re.compile(r"-step0*(\d+)\.safetensors$")


def _kill(proc) -> None:
    """graceful stop。SIGTERM で 30 秒待ち、往生際が悪ければ SIGKILL。
    sd-scripts はシグナルを受けると書きかけの safetensors を閉じてから落ちる
    ので、いきなり kill すると壊れたチェックポイントが残り得る。"""
    try:
        proc.terminate()
        proc.wait(timeout=30)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def _persist_checkpoints(
    output_dir: str, lora_name: str, user_id: str, job_id: str, declared_steps: int
) -> list[dict]:
    """output_dir に出ている .safetensors を **全部** loras/<user_id>/<job_id>/
    へ複製し、完了画面がそのまま使える checkpoints 配列を返す。

    2026-09-21 までは最終 1 個しか残しておらず、
    (a) CLAUDE.md §3 の「中間チェックポイントを永続化して個別ダウンロード可能に
        する」を SDXL だけ満たしていない
    (b) 安全停止・失敗時に途中結果が丸ごと消える（= salvage が効かない）
    という2つのギャップがあった。成功パスと停止パスの両方からこれを呼ぶ。

    ⚠️ Volume(v1) はバイト数より **ファイル数**（推奨5万 inode）が先に効く。
    save_every は _build_train_args が最大20回に抑えているので、1ジョブあたり
    最大21ファイル。
    """
    out = pathlib.Path(output_dir)
    files = sorted(out.glob("*.safetensors"))
    if not files:
        return []
    # 最終 = サフィックスの無いファイル。無ければ step 番号が最大のもの。
    final = next((f for f in files if not _SDXL_CKPT_STEP_RE.search(f.name)), files[-1])
    job_dir = (
        pathlib.Path(LORA_OUTPUT_DIR) / user_id / job_id if (user_id and job_id) else None
    )
    if job_dir is not None:
        job_dir.mkdir(parents=True, exist_ok=True)
    checkpoints: list[dict] = []
    for f in files:
        m = _SDXL_CKPT_STEP_RE.search(f.name)
        is_final = f == final
        step = int(m.group(1)) if m else (declared_steps if is_final else 0)
        entry: dict = {
            "step": step,
            "filename": f"{lora_name}_final.safetensors" if is_final else f.name,
            "size_bytes": f.stat().st_size,
            "is_final": is_final,
        }
        if job_dir is not None:
            dest = job_dir / entry["filename"]
            shutil.copy2(f, dest)
            entry["path"] = f"loras/{user_id}/{job_id}/{dest.name}"
        checkpoints.append(entry)
    checkpoints.sort(key=lambda c: (c["is_final"], c["step"]))
    return checkpoints


@app.function(image=train_image, gpu=GPU_REQUEST, volumes={MODELS_DIR: vol}, timeout=10800, scaledown_window=2)
def train_sdxl_lora_job(params: dict) -> dict:
    """Production SDXL LoRA training entrypoint — the sd-scripts counterpart
    of modal_lora_worker.py's train_lora_job. Same job-row lifecycle
    contract (generation_jobs PATCH progress/completion, credits refund on
    failure, same loras/<user_id>/<job_id>/<filename> output convention on
    the SAME Volume) so the existing checkpoint-download signed-URL endpoint
    and completed-screen UI need no changes to serve this worker's output —
    only /api/studio/lora/train's routing (arch==="sdxl" -> this dispatcher
    instead of modal_lora_worker.py's) remains to be wired up.

    params (subset of train_lora_job's — this worker is SDXL-only and has
    no raw-YAML/custom-config escape hatch yet):
      storage_paths / ingest_dir / images : same shape as train_lora_job
      captions / custom_captions          : same shape as train_lora_job
      training_config: {rank, alpha, learning_rate, steps, optimizer}
      keep_tokens: int, default DEFAULT_KEEP_TOKENS — see that constant's
                   docstring for the multi-subject (duo/group) exception
      resolution, output_lora_name, job_id, user_id, credits_cost,
      trigger_word

    Cost-guard (CLAUDE.md §3, 2026-09-21): the projected wall time is
    recomputed from a trimmed s/it average once SDXL_COST_MIN_STEP real
    steps are in; over the cap -> graceful stop, partial checkpoints are
    persisted to loras/<user_id>/<job_id>/, credits fully refunded. The cap
    is normally the value Next.js pre-computed from pricing_knobs and sent
    as payload cost_cap_seconds (admin-editable, no redeploy); without it,
    _cost_cap_seconds derives one here from SDXL_SPI_BASELINE (0.642 s/it,
    2026-09-20 measurement — see that constant) and the L40S hourly rate.
    The hard `timeout=` below stays as the last-resort ceiling.
    """
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[sdxl] vol.reload() skipped: {exc}", flush=True)

    job_id = str(params.get("job_id") or "")
    user_id = str(params.get("user_id") or "")
    credits_cost = int(params.get("credits_cost") or 0)
    lora_name = str(params.get("output_lora_name") or "").strip()
    if not lora_name or not re.match(r"^[A-Za-z0-9._-]+$", lora_name):
        raise ValueError(f"invalid output_lora_name: {lora_name!r}")
    resolution = int(params.get("resolution") or 1024)
    tc = dict(params.get("training_config") or {})
    keep_tokens = int(params.get("keep_tokens") or DEFAULT_KEEP_TOKENS)
    trigger = _derive_trigger(params, lora_name)
    started = time.time()

    try:
        if job_id and not _claim_job(
            job_id,
            {
                "status": "processing",
                "started_at": _now_iso(),
                "progress_percent": 1,
                "progress_message": "preparing dataset",
            },
        ):
            print(f"[sdxl] job {job_id} is no longer 'queued' (cancelled/superseded) — aborting", flush=True)
            return {"aborted": True, "job_id": job_id}

        work_dir = pathlib.Path(_job_output_dir(job_id or lora_name))
        if work_dir.exists():
            shutil.rmtree(work_dir)
        dataset_dir = work_dir / "dataset"
        output_dir = work_dir / "output"
        image_paths = _stage_dataset(params, dataset_dir, trigger)
        _patch_job(job_id, {"progress_percent": 10, "progress_message": f"{len(image_paths)}枚を学習準備中"})

        dataset_toml = _write_dataset_toml(str(work_dir), str(dataset_dir), resolution, keep_tokens)
        output_dir.mkdir(parents=True, exist_ok=True)

        pretrained_model, mixed_precision = _resolve_base_model(params)
        print(f"[sdxl] base model -> {pretrained_model} (mixed_precision={mixed_precision})", flush=True)
        sys.path.insert(0, SD_SCRIPTS_DIR)
        args = [sys.executable, f"{SD_SCRIPTS_DIR}/sdxl_train_network.py"] + _build_train_args(
            lora_name,
            dataset_toml,
            str(output_dir),
            tc,
            resolution=resolution,
            pretrained_model=pretrained_model,
            mixed_precision=mixed_precision,
        )

        # 原価割れ損切り（CLAUDE.md §3）。本筋は Next.js が pricing_knobs から
        # 算出して payload cost_cap_seconds で渡してくる値。無い/0 のときだけ
        # ワーカー内で算出する。
        try:
            cost_cap_override = int(float(params.get("cost_cap_seconds") or 0))
        except (TypeError, ValueError):
            cost_cap_override = 0
        declared_steps = int(tc.get("steps") or 0)
        cost_cap_s, cap_reason = _cost_cap_seconds(
            credits_cost, declared_steps, override_s=cost_cap_override
        )
        print(f"[sdxl] cost-guard: {cap_reason}", flush=True)

        _patch_job(job_id, {"progress_percent": 15, "progress_message": "学習開始"})
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        last_progress_patch = 0.0
        tail_lines: list[str] = []
        rate_hist: list[tuple[float, int]] = []
        first_step = 0
        last_step = 0
        last_total = 0
        aborted = ""
        last_ckpt_scan = 0.0
        committed_ckpts = 0
        for line in proc.stdout:
            tail_lines.append(line.rstrip("\n"))
            if len(tail_lines) > 200:
                tail_lines = tail_lines[-200:]
            m = _SDXL_STEP_RE.search(line)
            now = time.time()
            if m:
                cur, total = int(m.group(1)), int(m.group(2))
                if cur > last_step:
                    if not rate_hist:
                        first_step = cur
                    rate_hist.append((now, cur))
                    if len(rate_hist) > 120:
                        rate_hist = rate_hist[-120:]
                    last_step, last_total = cur, total
                # ~8s cadence, matching CLAUDE.md §6's async-tab VRAM live-update rate.
                if now - last_progress_patch > 8:
                    pct = 15 + int(80 * cur / max(1, total))
                    vram = _current_effective_vram_gb()
                    fields: dict = {"progress_percent": min(95, pct), "progress_message": f"学習中 {cur}/{total}"}
                    if vram is not None:
                        fields["metadata"] = {"vram_used_gb": vram}
                    _patch_job(job_id, fields)
                    last_progress_patch = now

            # 中間チェックポイントを走行中に Volume へ commit しておく。
            # output_dir は Volume 上（_job_output_dir -> /models/outputs_sdxl/…）
            # だが、commit しない限り他のコンテナからは見えないため、コンテナ
            # タイムアウトや Modal 側の kill で落ちたときに salvage できない。
            # ファイル数が増えたときだけ commit するので、保存が無い間は I/O 0。
            if now - last_ckpt_scan > 30:
                last_ckpt_scan = now
                try:
                    n_ckpt = len(list(output_dir.glob("*.safetensors")))
                    if n_ckpt > committed_ckpts:
                        vol.commit()
                        committed_ckpts = n_ckpt
                        print(f"[sdxl] committed {n_ckpt} checkpoint(s) to the Volume", flush=True)
                except Exception as commit_exc:  # noqa: BLE001 — never fatal
                    print(f"[sdxl] intermediate commit skipped: {commit_exc!r}", flush=True)

            # 実 step が SDXL_COST_MIN_STEP 本たまってから（= 初回のロード/JIT を
            # 平均から外してから）、残り step の所要を予測して cap と比べる。
            if (last_step - first_step) >= SDXL_COST_MIN_STEP and last_total > 0:
                spi = _trimmed_spi(rate_hist)
                if spi and spi > 0:
                    remaining = max(0, last_total - last_step)
                    projected_total = (now - started) + remaining * spi
                    if projected_total > cost_cap_s:
                        aborted = (
                            f"原価割れ防止のため安全停止しました。予測所要 "
                            f"{projected_total / 3600:.2f}h が上限 {cost_cap_s / 3600:.2f}h を"
                            f"超えています（実測 {spi:.2f}s/it・Step {last_step}/{last_total} で停止）。"
                            f"クレジットは全額返金され、そこまでの中間チェックポイントは"
                            f"ダウンロードできます。"
                        )
                        break

        if aborted:
            print(f"[sdxl] SAFETY ABORT (cost): {aborted}", flush=True)
            _patch_job(job_id, {"progress_message": "安全停止処理中（中間結果を保存しています）…"})
            _kill(proc)
            # 途中までのチェックポイントを Volume に残してから投げる
            # （ai-toolkit 側の salvage と同じ趣旨）。
            salvaged = _persist_checkpoints(str(output_dir), lora_name, user_id, job_id, last_step)
            try:
                vol.commit()
            except Exception as commit_exc:  # noqa: BLE001
                print(f"[sdxl] salvage commit skipped: {commit_exc}", flush=True)
            print(f"[sdxl] salvaged {len(salvaged)} checkpoint(s)", flush=True)
            raise SafetyLimitError(aborted, kind="cost", checkpoints=salvaged)
        returncode = proc.wait()
        if returncode != 0:
            raise RuntimeError(f"sd-scripts exited {returncode}:\n" + "\n".join(tail_lines[-40:]))

        produced = sorted(pathlib.Path(output_dir).glob("*.safetensors"))
        if not produced:
            raise RuntimeError("sd-scripts finished with no .safetensors output")
        # 最終 = step サフィックスの付かないファイル（sd-scripts の最終保存）。
        # 中間保存も同じディレクトリに並ぶので、名前順の末尾に頼らず明示的に選ぶ。
        final_ckpt = next(
            (f for f in produced if not _SDXL_CKPT_STEP_RE.search(f.name)), produced[-1]
        )

        # Optional metadata-tag embedding (host-typed, e.g. "kocho, 1man, fat:21,
        # obese, bald, glasses" — see _embed_metadata_tags docstring). Applied to
        # final_ckpt BEFORE copying so both the model-library alias and the
        # per-job archive inherit the same rewritten metadata. A parse failure
        # here must never sink an otherwise-successful training run — the
        # checkpoint still ships with sd-scripts' own native metadata intact.
        embedded_tag_keys: list[str] = []
        embed_tags_raw = str(params.get("embed_tags") or "").strip()
        if embed_tags_raw:
            try:
                embed_tags = _parse_embed_tags(embed_tags_raw)
                embedded_tag_keys = _embed_metadata_tags(str(final_ckpt), embed_tags)
                print(f"[sdxl] embedded metadata tags {list(embed_tags)} -> keys {embedded_tag_keys}", flush=True)
            except TagParseError as exc:
                print(f"[sdxl] embed_tags parse failed ({exc!r}) — skipping metadata embed", flush=True)

        # ベースモデルのライセンスが派生モデル（= この LoRA）にも及ぶ場合は、
        # ファイル自体にそれが残るよう metadata へ焼き込む（_PRESET_LICENSE の
        # コメント参照）。embed_tags の後に実行すること — あちらも save_file で
        # 書き戻すので、順序が逆だとライセンス表記が消える。
        # ⚠️ 学習は成功しているので、ここで失敗しても絶対にジョブを落とさない。
        license_info = _license_for(params)
        license_keys: list[str] = []
        if license_info:
            try:
                license_keys = _stamp_license_metadata(
                    str(final_ckpt), license_info, license_info["base_label"]
                )
                print(f"[sdxl] stamped license metadata: {license_info['name']}", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"[sdxl] license stamp skipped: {exc!r}", flush=True)

        os.makedirs(LORA_OUTPUT_DIR, exist_ok=True)
        dest_path = pathlib.Path(LORA_OUTPUT_DIR) / f"{lora_name}.safetensors"
        shutil.copy2(final_ckpt, dest_path)
        # 中間チェックポイントも含めて全部 loras/<user_id>/<job_id>/ へ残す
        # （CLAUDE.md §3「中間 .safetensors を永続化し、完了画面で個別
        # ダウンロードを可能にする」）。
        #
        # 🐛 2026-09-21 修正: 以前はここで最終1個だけを残し、metadata には
        # filename="<name>.safetensors" と書きながら実ファイルは
        # "<name>_final.safetensors" で置いていた。ダウンロード API
        # （/api/studio/lora/checkpoint）は metadata の filename をそのまま
        # loras/<user>/<job>/<filename> として引くので、**最終 LoRA の
        # ダウンロードが必ず 404 になっていた**。_persist_checkpoints は
        # 実際に書いた名前をそのまま filename に入れる。
        checkpoints = _persist_checkpoints(
            str(output_dir), lora_name, user_id, job_id, declared_steps
        )
        # LICENSE.txt をジョブフォルダにも置く（一括DL の ZIP に入る）。
        if license_info and user_id and job_id:
            try:
                _write_license_file(
                    pathlib.Path(LORA_OUTPUT_DIR) / user_id / job_id,
                    license_info,
                    license_info["base_label"],
                    lora_name,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[sdxl] LICENSE.txt skipped: {exc!r}", flush=True)

        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception as rm_exc:  # noqa: BLE001
            print(f"[sdxl] work dir cleanup skipped: {rm_exc}", flush=True)
        vol.commit()

        final_vram = _current_effective_vram_gb()
        metadata: dict = {"checkpoints": checkpoints}
        if final_vram is not None:
            metadata["vram_used_gb"] = final_vram
        if embedded_tag_keys:
            metadata["embedded_tag_keys"] = embedded_tag_keys
        if license_info:
            # 完了画面や監査で「どのライセンスで提供したか」を追えるようにする。
            metadata["license"] = license_info["name"]
            metadata["license_url"] = license_info["url"]
            metadata["license_metadata_keys"] = license_keys
        _patch_job(
            job_id,
            {
                "status": "completed",
                "progress_percent": 100,
                "progress_message": "done",
                "result_path": str(dest_path),
                "video_url": str(dest_path),
                "metadata": metadata,
                "completed_at": _now_iso(),
            },
        )
        return {
            "lora_path": str(dest_path),
            "lora_filename": dest_path.name,
            "size_bytes": dest_path.stat().st_size,
            "num_images": len(image_paths),
            "trigger_word": trigger,
            "total_seconds": round(time.time() - started, 1),
            "checkpoints": checkpoints,
            "embedded_tag_keys": embedded_tag_keys,
        }
    except Exception as exc:  # report + refund, then re-raise
        print(f"[sdxl] FAILED: {exc}", flush=True)
        infra = _is_infra_error(exc)
        safety = isinstance(exc, SafetyLimitError)
        # No raw-config escape hatch in this worker yet (unlike train_lora_job's
        # custom_yaml_override) -> every failure here is either a transient
        # infra fault, a deliberate cost-guard stop, or a system-side bug —
        # never a user-authored config crash. Always refund until a raw/
        # advanced mode is added.
        should_refund = True
        failure_meta: dict = {"refunded": should_refund, "infra_error": infra}
        if safety:
            failure_meta["safety_stop"] = getattr(exc, "kind", "cost")
            salvaged_ckpts = getattr(exc, "checkpoints", None)
            if salvaged_ckpts:
                failure_meta["checkpoints"] = salvaged_ckpts
        else:
            # 安全停止パスは既に自分で保存済み。それ以外の失敗（sd-scripts の
            # 異常終了・infra エラー）でも、そこまでに書けた中間チェックポイントが
            # あるなら捨てずに残す — ユーザーから見れば「落ちたが途中までは
            # 取り出せる」になり、返金と両立する。失敗処理自体は何があっても
            # 止めない。
            try:
                rescued = _persist_checkpoints(
                    str(output_dir), lora_name, user_id, job_id, 0
                )
                if rescued:
                    vol.commit()
                    failure_meta["checkpoints"] = rescued
                    print(f"[sdxl] rescued {len(rescued)} checkpoint(s) from a failed run", flush=True)
            except Exception as rescue_exc:  # noqa: BLE001 — best effort only
                print(f"[sdxl] checkpoint rescue skipped: {rescue_exc!r}", flush=True)
        _patch_job(
            job_id,
            {
                "status": "failed",
                "error_message": str(exc)[:2000],
                "metadata": failure_meta,
                "completed_at": _now_iso(),
            },
        )
        if should_refund:
            _refund_credits(user_id, credits_cost)
            print(f"[sdxl] job {job_id} failed — refunded {credits_cost}C", flush=True)
        raise


# GPU-less dispatcher — the future /api/studio/lora/train route.ts branch for
# arch==="sdxl" POSTs here; mirrors modal_lora_worker.py's train_lora_dispatch
# shape (auth -> .spawn() -> immediate ACK) so the Next.js side can treat
# both workers identically once wired up.
dispatch_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]", "modal", "requests")


@app.function(
    image=dispatch_image,
    timeout=30,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
)
@modal.fastapi_endpoint(method="POST")
def train_sdxl_lora_dispatch(item: dict, request: fastapi.Request):
    _authorize(request)
    if not item.get("output_lora_name"):
        raise fastapi.HTTPException(status_code=400, detail="output_lora_name is required")
    call = train_sdxl_lora_job.spawn(item)
    return {
        "ok": True,
        "spawned": True,
        "async": True,
        "modal_call_id": call.object_id,
        "job_id": item.get("job_id"),
        "status": "queued",
    }


@app.local_entrypoint()
def main():
    result = probe_imports.remote()
    print(result)
