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

import os

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
    .pip_install("modal")
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
# ecosystem's SDXL guidance/benchmarks assume) and Pillow for the smoke
# test's synthetic dataset generation.
train_image = image.pip_install("xformers==0.0.29.post3", "Pillow").env(
    {
        # Cache HF downloads (the ~7GB SDXL base checkpoint) on the persistent
        # Volume so repeated smoke-test runs don't re-download it every time.
        "HF_HOME": f"{MODELS_DIR}/hf_home_sdxl",
    }
)

SDXL_BASE_REPO = "stabilityai/stable-diffusion-xl-base-1.0"

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
    """
    rank = int(tc.get("rank", DEFAULT_TRAINING_CONFIG["rank"]))
    alpha = int(tc.get("alpha", DEFAULT_TRAINING_CONFIG["alpha"]))
    steps = int(tc.get("steps", DEFAULT_TRAINING_CONFIG["steps"]))
    optimizer_key = str(tc.get("optimizer", DEFAULT_TRAINING_CONFIG["optimizer"])).lower()
    optimizer_type = SD_SCRIPTS_OPTIMIZER_MAP.get(optimizer_key, "AdamW8bit")
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
    save_every = min(500, max(100, steps // 4))
    res = resolution if resolution in (512, 768, 1024, 1280) else 1024

    args = [
        f"--pretrained_model_name_or_path={SDXL_BASE_REPO}",
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
        "--mixed_precision=bf16",
        "--save_precision=bf16",
        "--cache_latents",
        "--gradient_checkpointing",
        "--sdpa",
        "--min_snr_gamma=5",
        "--seed=42",
        "--no_half_vae",
    ]
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


@app.function(image=train_image, gpu=GPU_REQUEST, volumes={MODELS_DIR: vol}, timeout=1800)
def smoke_test_sdxl_lora() -> dict:
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
    import time

    sys.path.insert(0, SD_SCRIPTS_DIR)

    work = pathlib.Path("/root/smoke")
    work.mkdir(parents=True, exist_ok=True)
    dataset_toml = _write_smoke_dataset(str(work))
    output_dir = work / "output"
    output_dir.mkdir(exist_ok=True)

    # Exercises the REAL _build_config-equivalent (rank 16/alpha 8, 20 steps,
    # AdamW8bit @ 1e-4, 1024px) rather than a separately hand-maintained arg
    # list, so this smoke test also proves _build_train_args itself works.
    tc = {"rank": 16, "alpha": 8, "steps": 20, "optimizer": "adamw8bit", "learning_rate": 1e-4}
    args = [sys.executable, f"{SD_SCRIPTS_DIR}/sdxl_train_network.py"] + _build_train_args(
        "smoke_test", dataset_toml, str(output_dir), tc, resolution=1024
    )

    t0 = time.time()
    proc = subprocess.run(args, capture_output=True, text=True)
    elapsed = time.time() - t0
    print("[smoke] STDOUT tail:\n" + "\n".join(proc.stdout.splitlines()[-60:]), flush=True)
    print("[smoke] STDERR tail:\n" + "\n".join(proc.stderr.splitlines()[-60:]), flush=True)

    result: dict = {"returncode": proc.returncode, "elapsed_s": round(elapsed, 1)}
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


@app.local_entrypoint()
def main():
    result = probe_imports.remote()
    print(result)
