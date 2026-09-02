"""
MiniMax H3 LoRA trainer on Modal — one-shot pipeline: auto-caption a raw
image dataset with the Qwen3.8-27B VLM already sitting in the ull-wan-models
Volume, then bake a BF16 full-precision LoRA with ai-toolkit.

Everything runs against the same persistent Volume (ull-wan-models) that
production ComfyUI uses, so the finished LoRA lands directly in
/models/loras/ and is picked up by the next generation with no extra copy.

Pre-staged resources it expects on the Volume (mounted at /models):
  VLM              /models/LLM/Qwen3.8-27B-abliterated
  MiniMax H3 UNet  /models/diffusion_models/minimax_h3_fl2va_bf16.safetensors
  Text encoder     /models/clip/qwen3vl_32b_minimax_h3_bf16.safetensors
  VAE              /models/vae/minimax_h3_video_vae_fp16.safetensors
  Output           /models/loras/

Usage:
  modal run modal_train_minimax_lora.py \
      --data-dir /path/to/images \
      --lora-name yukipas_h3 \
      [--trigger-word yukipas] [--steps 2000] [--rank 32]

  The local --data-dir is scanned for images (png/jpg/jpeg/webp), each is
  base64'd and shipped to the Modal container, captioned, trained on, and
  the resulting <lora-name>.safetensors is committed back to the Volume.

GPU: requests H100 first, falls back to A100-80GB when H100 capacity is
tight (gpu=["H100", "A100-80GB"]). On H100 the whole run is ~10s captioning
+ ~10-12min training.

Env overrides:
  MINIMAX_LORA_GPU   pin a single GPU type instead of the H100->A100 list
  AI_TOOLKIT_REF     ai-toolkit git ref to pin (default: main)
"""

import base64
import os
import pathlib
import subprocess
import time

import modal

app = modal.App("ull-minimax-lora-train")

MODELS_DIR = "/models"
DATASET_DIR = "/root/dataset"
OUTPUT_DIR = "/root/output"
AI_TOOLKIT_DIR = "/root/ai-toolkit"

# Volume model paths (see module docstring).
VLM_PATH = f"{MODELS_DIR}/LLM/Qwen3.8-27B-abliterated"
UNET_PATH = f"{MODELS_DIR}/diffusion_models/minimax_h3_fl2va_bf16.safetensors"
TEXT_ENCODER_PATH = f"{MODELS_DIR}/clip/qwen3vl_32b_minimax_h3_bf16.safetensors"
VAE_PATH = f"{MODELS_DIR}/vae/minimax_h3_video_vae_fp16.safetensors"
LORA_OUTPUT_DIR = f"{MODELS_DIR}/loras"

# H100 first for the fastest + cheapest run (best $/step of the two), with
# A100-80GB as an automatic fallback when H100 capacity is tight. Modal
# accepts an ordered list here and the SDK doesn't validate the strings
# client-side (see parse_gpu_config in modal/_utils/function_utils.py). Set
# MINIMAX_LORA_GPU to pin a single type.
_GPU_ENV = os.environ.get("MINIMAX_LORA_GPU", "").strip()
GPU_REQUEST = _GPU_ENV if _GPU_ENV else ["H100", "A100-80GB"]
AI_TOOLKIT_REF = os.environ.get("AI_TOOLKIT_REF", "main")

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

# Instruction the VLM gets for every dataset image. Framing/composition and
# part-detail features are kept in *separate, non-overlapping* tag groups so
# the LoRA learns "what the character looks like" independently of "how it's
# cropped" — composition words never leak into the part descriptions and
# vice versa. Output order: trigger, one framing tag, part tags, scene tags.
CAPTION_INSTRUCTION = (
    "You are tagging one training image of a single character. Produce a "
    "single line of comma-separated lowercase tags with NO sentences.\n"
    "Build the line in this exact order, keeping the groups strictly separate:\n"
    "1) the literal trigger token '{trigger}'.\n"
    "2) FRAMING (exactly one, composition only, no body/part details): one of "
    "'head close-up', 'upper body', 'lower body and boots', 'full-body standing view'.\n"
    "3) PART FEATURES (appearance only, never mention crop/zoom/framing): hair "
    "colour and style, eye colour, and every distinctive accessory or costume "
    "detail (e.g. red crescent ornaments, blue rose corsages, gold filigree, "
    "lace, ribbons), each as its own short tag.\n"
    "4) SCENE: background description and lighting, each as its own tag.\n"
    "Do not repeat the framing idea inside the part or scene tags. Output only "
    "the tag line."
)

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)

# CUDA 12.4 PyTorch + the VLM (transformers/accelerate/qwen-vl-utils) and
# ai-toolkit dependency stacks. ai-toolkit itself is cloned at build time and
# its requirements installed so the training entrypoint is `python run.py`.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "libgl1-mesa-glx", "libglib2.0-0", "wget")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        # Stage 1 — Qwen VLM captioning.
        "transformers>=4.49.0",
        "accelerate>=1.2.0",
        "qwen-vl-utils",
        "Pillow",
        "sentencepiece",
        "einops",
        "safetensors",
        # Stage 2 — ai-toolkit trainer deps (superset kept explicit so an
        # ai-toolkit requirements.txt drift doesn't silently drop one).
        "diffusers>=0.32.0",
        "peft>=0.14.0",
        "bitsandbytes",
        "pyyaml",
        "omegaconf",
        "oyaml",
        "albumentations",
        "opencv-python-headless",
        "prodigyopt",
        "lycoris-lora",
        "toml",
    )
    .run_commands(
        f"git clone https://github.com/ostris/ai-toolkit.git {AI_TOOLKIT_DIR}",
        f"cd {AI_TOOLKIT_DIR} && git checkout {AI_TOOLKIT_REF} && git submodule update --init --recursive",
        # Best-effort — the explicit pip_install list above already covers the
        # trainer; this just fills any extras the pinned ref happens to add.
        f"cd {AI_TOOLKIT_DIR} && pip install -r requirements.txt || echo 'ai-toolkit requirements.txt partial install, continuing'",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "PYTHONUNBUFFERED": "1"})
)


# ---------------------------------------------------------------------------
# Stage 1 — Qwen3.8-27B batch captioning
# ---------------------------------------------------------------------------
def _run_captioning(image_paths: list[pathlib.Path], trigger_word: str) -> list[str]:
    """Loads the Volume-resident Qwen VLM once and writes a <stem>.txt next
    to every image. Returns the generated captions in the same order."""
    import torch
    from transformers import AutoProcessor

    instruction = CAPTION_INSTRUCTION.format(trigger=trigger_word)
    print(f"[stage1] loading VLM from {VLM_PATH}")

    # The exact HF architecture class name for this checkpoint isn't known
    # ahead of time (it's an abliterated Qwen-VL derivative), so try the
    # generic multimodal class first, then the Qwen2.5-VL class, then a
    # trust_remote_code fallback.
    model = None
    load_errors = []
    for loader in ("image-text-to-text", "qwen2_5_vl", "auto"):
        try:
            if loader == "image-text-to-text":
                from transformers import AutoModelForImageTextToText

                model = AutoModelForImageTextToText.from_pretrained(
                    VLM_PATH, torch_dtype=torch.bfloat16, device_map="auto", attn_implementation="sdpa"
                )
            elif loader == "qwen2_5_vl":
                from transformers import Qwen2_5_VLForConditionalGeneration

                model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
                    VLM_PATH, torch_dtype=torch.bfloat16, device_map="auto", attn_implementation="sdpa"
                )
            else:
                from transformers import AutoModelForCausalLM

                model = AutoModelForCausalLM.from_pretrained(
                    VLM_PATH, torch_dtype=torch.bfloat16, device_map="auto", trust_remote_code=True
                )
            print(f"[stage1] loaded VLM via {loader}")
            break
        except Exception as exc:  # noqa: BLE001 — try the next loader
            load_errors.append(f"{loader}: {exc}")
    if model is None:
        raise RuntimeError("could not load the VLM with any known loader:\n" + "\n".join(load_errors))

    processor = AutoProcessor.from_pretrained(VLM_PATH, trust_remote_code=True)
    # Left padding is required for correct batched decoder-only generation.
    if getattr(processor, "tokenizer", None) is not None:
        processor.tokenizer.padding_side = "left"

    try:
        from qwen_vl_utils import process_vision_info
    except Exception:  # noqa: BLE001
        process_vision_info = None

    from PIL import Image

    def _postprocess(raw: str) -> str:
        # Keep the single tag line, normalise whitespace, guarantee the
        # trigger token leads even if the model dropped/reworded it.
        line = " ".join(raw.strip().splitlines()).strip().strip('"')
        line = ", ".join(t.strip() for t in line.split(",") if t.strip())
        if not line.lower().startswith(trigger_word.lower()):
            line = f"{trigger_word}, {line}"
        return line

    # Batched generation — an 8-wide batch keeps a typical 20-40 image
    # character set at roughly the ~10s target on an H100.
    batch_size = int(os.environ.get("CAPTION_BATCH", "8"))
    captions: list[str] = []
    for start in range(0, len(image_paths), batch_size):
        chunk = image_paths[start : start + batch_size]
        batch_texts: list[str] = []
        batch_images: list = []
        for img_path in chunk:
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": f"file://{img_path}"},
                        {"type": "text", "text": instruction},
                    ],
                }
            ]
            batch_texts.append(processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True))
            if process_vision_info is not None:
                imgs, _ = process_vision_info(messages)
                batch_images.append(imgs[0] if imgs else Image.open(img_path).convert("RGB"))
            else:
                batch_images.append(Image.open(img_path).convert("RGB"))

        inputs = processor(text=batch_texts, images=batch_images, padding=True, return_tensors="pt").to(model.device)
        with torch.inference_mode():
            generated = model.generate(**inputs, max_new_tokens=200, do_sample=False)
        trimmed = generated[:, inputs["input_ids"].shape[1] :]
        decoded = processor.batch_decode(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)

        for offset, (img_path, raw) in enumerate(zip(chunk, decoded)):
            caption = _postprocess(raw)
            img_path.with_suffix(".txt").write_text(caption, encoding="utf-8")
            captions.append(caption)
            print(f"[stage1] ({start + offset + 1}/{len(image_paths)}) {img_path.name}: {caption[:120]}")

    # Free VRAM before ai-toolkit loads the diffusion model.
    del model
    torch.cuda.empty_cache()
    return captions


# ---------------------------------------------------------------------------
# Stage 2 — ai-toolkit MiniMax H3 LoRA training
# ---------------------------------------------------------------------------
def _write_ai_toolkit_config(
    lora_name: str, trigger_word: str, steps: int, rank: int, alpha: int, lr: float, save_every: int
) -> pathlib.Path:
    """Builds an ai-toolkit (ostris) job YAML pointed at the dataset folder
    and the Volume's MiniMax H3 weights. `arch: minimax_h3` and the
    explicit extra-weight keys track the current ai-toolkit MiniMax support;
    adjust here if the pinned ref renames them."""
    import yaml

    config = {
        "job": "extension",
        "config": {
            "name": lora_name,
            "process": [
                {
                    "type": "sd_trainer",
                    "training_folder": OUTPUT_DIR,
                    "device": "cuda:0",
                    "trigger_word": trigger_word,
                    "network": {"type": "lora", "linear": rank, "linear_alpha": alpha},
                    "save": {
                        "dtype": "bf16",
                        "save_every": save_every,
                        "max_step_saves_to_keep": 6,
                        "push_to_hub": False,
                    },
                    "datasets": [
                        {
                            "folder_path": DATASET_DIR,
                            "caption_ext": "txt",
                            "caption_dropout_rate": 0.05,
                            "shuffle_tokens": False,
                            "cache_latents_to_disk": True,
                            "resolution": [512, 768, 1024],
                        }
                    ],
                    "train": {
                        "batch_size": 1,
                        "steps": steps,
                        "gradient_accumulation_steps": 1,
                        "train_unet": True,
                        "train_text_encoder": False,
                        "gradient_checkpointing": True,
                        "noise_scheduler": "flowmatch",
                        "optimizer": "adamw8bit",
                        "lr": lr,
                        "dtype": "bf16",
                    },
                    "model": {
                        "name_or_path": UNET_PATH,
                        "arch": "minimax_h3",
                        "quantize": False,
                        # Explicit component paths — MiniMax H3 is a
                        # single-file UNet, so its text encoder / VAE must be
                        # pointed at directly rather than resolved from a
                        # diffusers repo layout.
                        "text_encoder_path": TEXT_ENCODER_PATH,
                        "vae_path": VAE_PATH,
                    },
                    "sample": {
                        "sampler": "flowmatch",
                        "sample_every": save_every,
                        "width": 768,
                        "height": 768,
                        "prompts": [f"{trigger_word}, full-body standing view, studio lighting"],
                        "neg": "",
                        "seed": 42,
                        "walk_seed": True,
                        "guidance_scale": 4.0,
                        "sample_steps": 20,
                    },
                }
            ],
        },
        "meta": {"name": lora_name, "version": "1.0"},
    }

    config_path = pathlib.Path(AI_TOOLKIT_DIR) / f"config_{lora_name}.yaml"
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    print(f"[stage2] wrote ai-toolkit config -> {config_path}")
    return config_path


def _run_ai_toolkit(config_path: pathlib.Path) -> None:
    cmd = ["python", "run.py", str(config_path)]
    print(f"[stage2] launching ai-toolkit: {' '.join(cmd)} (cwd={AI_TOOLKIT_DIR})")
    proc = subprocess.run(cmd, cwd=AI_TOOLKIT_DIR, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"ai-toolkit run.py exited with code {proc.returncode}")


def _collect_final_lora(lora_name: str) -> pathlib.Path:
    """Finds the newest .safetensors ai-toolkit produced for this job."""
    job_dir = pathlib.Path(OUTPUT_DIR) / lora_name
    candidates = sorted(job_dir.glob("**/*.safetensors"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        raise RuntimeError(f"no .safetensors found under {job_dir}")
    return candidates[-1]


@app.function(
    image=image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    # ~10s captioning + ~10-12min training on H100 for the default 2000
    # steps; the wide ceiling only guards a large dataset / A100 fallback.
    timeout=2 * 60 * 60,
    # 30s Keep-Warm 規格（CLAUDE.md §1）— 全 GPU ワーカー一律。
    scaledown_window=30,
)
def train(
    images_b64: dict,
    lora_name: str,
    trigger_word: str = "yukipas",
    steps: int = 2000,
    rank: int = 32,
    alpha: int = 32,
    lr: float = 1e-4,
    save_every: int = 500,
) -> dict:
    """One-shot: caption `images_b64` with the Qwen VLM, train a MiniMax H3
    LoRA with ai-toolkit, and commit <lora_name>.safetensors to the Volume's
    loras/ folder."""
    import shutil

    if not (1000 <= steps <= 4000):
        print(f"[train] clamping steps {steps} into [1000, 4000]")
        steps = max(1000, min(4000, steps))

    for required in (VLM_PATH, UNET_PATH, TEXT_ENCODER_PATH, VAE_PATH):
        if not os.path.exists(required):
            raise FileNotFoundError(f"required resource missing on the Volume: {required}")

    # Materialise the dataset.
    dataset = pathlib.Path(DATASET_DIR)
    if dataset.exists():
        shutil.rmtree(dataset)
    dataset.mkdir(parents=True)
    image_paths: list[pathlib.Path] = []
    for name, b64 in images_b64.items():
        safe_name = os.path.basename(name)
        dest = dataset / safe_name
        dest.write_bytes(base64.b64decode(b64))
        image_paths.append(dest)
    image_paths.sort()
    print(f"[train] staged {len(image_paths)} images into {dataset}")
    if not image_paths:
        raise ValueError("no images were provided")

    started = time.time()
    captions = _run_captioning(image_paths, trigger_word)
    print(f"[train] stage 1 (captioning) done in {time.time() - started:.0f}s")

    pathlib.Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
    config_path = _write_ai_toolkit_config(lora_name, trigger_word, steps, rank, alpha, lr, save_every)

    stage2_start = time.time()
    _run_ai_toolkit(config_path)
    print(f"[train] stage 2 (ai-toolkit) done in {time.time() - stage2_start:.0f}s")

    final_lora = _collect_final_lora(lora_name)
    os.makedirs(LORA_OUTPUT_DIR, exist_ok=True)
    dest_path = pathlib.Path(LORA_OUTPUT_DIR) / f"{lora_name}.safetensors"
    shutil.copy2(final_lora, dest_path)
    vol.commit()
    print(f"[train] committed LoRA -> {dest_path} ({dest_path.stat().st_size / 1024**2:.1f} MB)")

    return {
        "lora_path": str(dest_path),
        "lora_filename": dest_path.name,
        "size_bytes": dest_path.stat().st_size,
        "num_images": len(image_paths),
        "steps": steps,
        "sample_captions": captions[:5],
        "total_seconds": round(time.time() - started, 1),
    }


# ---------------------------------------------------------------------------
# Local CLI entrypoint
# ---------------------------------------------------------------------------
@app.local_entrypoint()
def main(
    data_dir: str,
    lora_name: str,
    trigger_word: str = "yukipas",
    steps: int = 2000,
    rank: int = 32,
    alpha: int = 32,
    lr: float = 1e-4,
    save_every: int = 500,
):
    """modal run modal_train_minimax_lora.py --data-dir <dir> --lora-name <name>"""
    src = pathlib.Path(data_dir).expanduser()
    if not src.is_dir():
        raise SystemExit(f"--data-dir is not a directory: {src}")

    images_b64: dict[str, str] = {}
    total_bytes = 0
    for path in sorted(src.iterdir()):
        if path.suffix.lower() not in IMAGE_EXTS or not path.is_file():
            continue
        raw = path.read_bytes()
        total_bytes += len(raw)
        images_b64[path.name] = base64.b64encode(raw).decode("ascii")

    if not images_b64:
        raise SystemExit(f"no images ({', '.join(sorted(IMAGE_EXTS))}) found in {src}")
    if total_bytes > 1_500_000_000:
        raise SystemExit(f"dataset is {total_bytes / 1024**2:.0f} MB — too large to ship as a single call; downscale it first")

    gpu_label = GPU_REQUEST if isinstance(GPU_REQUEST, str) else " -> ".join(GPU_REQUEST)
    print(f"[main] uploading {len(images_b64)} images ({total_bytes / 1024**2:.1f} MB) -> Modal ({gpu_label})")
    print(f"[main] lora_name={lora_name} trigger={trigger_word} steps={steps} rank={rank}/{alpha} lr={lr}")

    result = train.remote(
        images_b64=images_b64,
        lora_name=lora_name,
        trigger_word=trigger_word,
        steps=steps,
        rank=rank,
        alpha=alpha,
        lr=lr,
        save_every=save_every,
    )

    print("\n[main] ✅ training complete")
    print(f"[main] LoRA saved to Volume: {result['lora_path']} ({result['size_bytes'] / 1024**2:.1f} MB)")
    print(f"[main] {result['num_images']} images, {result['steps']} steps, {result['total_seconds']}s wall time")
    print("[main] sample captions:")
    for cap in result["sample_captions"]:
        print(f"       - {cap}")
