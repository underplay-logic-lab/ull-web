"""CPU-only probe (2026-10-04): can LoRA Studio's minimax_h3 training read the bf16 weights Director already has,
instead of dequantizing the int8_convrot DiT (~270s) / nvfp4 TE (~8 min) on every job?  docs/STATUS.md 次の一手 5.

    PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_minimax_bf16_probe.py

No GPU, read-only Volume. Reads only safetensors headers (a few MB) + ai-toolkit's minimax_h3.py from the training
image, then builds the TE skeleton on the meta device and diffs its state_dict keys against the bf16 file.
"""

from __future__ import annotations

import modal

import modal_lora_worker as W

app = modal.App("ull-minimax-bf16-probe")

RAW_YAML = """job: extension
config:
  name: x
  process:
  - type: sd_trainer
    model:
      arch: minimax_h3
      name_or_path: /tmp/x
    train:
      steps: 10
"""

PROBE_IMAGE = W.image.add_local_python_source("modal_lora_worker", "modal_minimax_bf16_probe")


def _header(path: str) -> dict:
    import json
    import struct

    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        h = json.loads(f.read(n))
    h.pop("__metadata__", None)
    return h


def _summarize(path: str) -> dict:
    import collections
    import os
    import re

    h = _header(path)
    prefixes = collections.Counter(".".join(k.split(".")[:3]) for k in h)
    dtypes = collections.Counter(v["dtype"] for v in h.values())
    layer_ids = sorted({int(m.group(1)) for k in h for m in [re.search(r"\.layers\.(\d+)\.", k)] if m})
    block_ids = sorted({int(m.group(1)) for k in h for m in [re.search(r"blocks\.(\d+)\.", k)] if m})
    return {
        "path": path,
        "size_gb": round(os.path.getsize(path) / 1e9, 2),
        "n_keys": len(h),
        "dtypes": dict(dtypes),
        "top_prefixes": prefixes.most_common(25),
        "layers": [layer_ids[0], layer_ids[-1], len(layer_ids)] if layer_ids else None,
        "blocks": [block_ids[0], block_ids[-1], len(block_ids)] if block_ids else None,
        "sample_keys": sorted(h)[:40],
        "block0_keys": sorted(k for k in h if re.search(r"(^|\.)(blocks|layers)\.0\.", k))[:80],
    }


@app.function(
    image=PROBE_IMAGE,
    volumes={W.MODELS_DIR: W.vol_ro},
    secrets=[modal.Secret.from_name("huggingface-secret")],
    timeout=30 * 60,
    scaledown_window=2,
)
def probe() -> dict:
    import glob
    import os
    import re

    out: dict = {}
    clip = sorted(glob.glob(f"{W.MODELS_DIR}/clip/*minimax*")) + sorted(glob.glob(f"{W.MODELS_DIR}/text_encoders/*minimax*"))
    found = []
    for root, dirs, files in os.walk(W.MODELS_DIR):
        if root.count("/") - W.MODELS_DIR.count("/") >= 3:
            dirs[:] = []
        dirs[:] = [d for d in dirs if d not in ("hf_cache", "lora_outputs", "lora_dataset_uploads", "persist", "custom_nodes")]
        found += [os.path.join(root, f) for f in files if "minimax_h3_fl2va" in f]
    out["found_fl2va"] = found
    dit = sorted(set(glob.glob(f"{W.MODELS_DIR}/diffusion_models/*minimax*") + found))
    out["files"] = {p: round(os.path.getsize(p) / 1e9, 2) for p in clip + dit}
    for p in clip + dit:
        if p.endswith(".safetensors"):
            try:
                out[f"hdr:{os.path.basename(p)}"] = _summarize(p)
            except Exception as e:  # noqa: BLE001
                out[f"hdr:{os.path.basename(p)}"] = repr(e)

    # The production config builder (GUI path + raw-YAML path) must point the TE at the bf16 file.
    try:
        import yaml

        import modal_lora_worker as WW

        cfgs = {}
        for label, override in (
            ("gui", None),
            ("raw_yaml", RAW_YAML),
        ):
            pth = WW._build_config(
                lora_name=f"probe_{label}", trigger="ullprobe", target_model="minimax_h3",
                tc={"rank": 16, "alpha": 16, "steps": 10, "batch_size": 1}, override=override,
                resolution=1024, output_dir="/tmp/probe_out",
            )
            y = yaml.safe_load(open(pth, encoding="utf-8"))
            mb = y["config"]["process"][0]["model"]
            cfgs[label] = {
                "text_encoder_path": mb.get("text_encoder_path"),
                "model_kwargs.text_encoder_path": (mb.get("model_kwargs") or {}).get("text_encoder_path"),
                "name_or_path": mb.get("name_or_path"),
            }
        out["build_config"] = cfgs
    except Exception:  # noqa: BLE001
        import traceback

        out["build_config"] = traceback.format_exc()[-2500:]

    # DiT: bf16 (Director) vs int8_convrot (training) key layout, quant aux keys stripped.
    try:
        aux = (".comfy_quant", ".weight_scale", ".weight_scale_2", ".pre_quant_scale", ".input_scale")
        q = [p for p in dit if "int8_convrot" in p]
        b = [p for p in dit if p.endswith("fl2va_bf16.safetensors")]
        if q and b:
            hq = {k: v for k, v in _header(q[0]).items() if not k.endswith(aux)}
            hb = _header(b[0])
            out["dit_diff"] = {
                "only_in_int8": sorted(set(hq) - set(hb))[:60],
                "n_only_in_int8": len(set(hq) - set(hb)),
                "only_in_bf16": sorted(set(hb) - set(hq))[:60],
                "n_only_in_bf16": len(set(hb) - set(hq)),
                "shape_diff": [
                    (k, hq[k]["shape"], hb[k]["shape"], hq[k]["dtype"], hb[k]["dtype"])
                    for k in sorted(set(hq) & set(hb))
                    if hq[k]["shape"] != hb[k]["shape"]
                ][:40],
            }
    except Exception as e:  # noqa: BLE001
        out["dit_diff"] = repr(e)

    # ai-toolkit's minimax_h3 source as built into the training image (main at build time).
    src_path = f"{W.AI_TOOLKIT_DIR}/extensions_built_in/diffusion_models/minimax_h3/minimax_h3.py"
    src = open(src_path, encoding="utf-8").read()
    marker = src.find("# ===== INJECTED BY ULL STUDIO PATCH")
    stock = src if marker < 0 else src[:marker]
    out["src_len"] = len(stock)
    out["src_consts"] = [ln for ln in stock.splitlines() if re.match(r"^[A-Z_]+\s*=", ln)]

    def _func(name: str) -> str:
        m = re.search(rf"\n    def {name}\(.*?(?=\n    def |\nclass |\Z)", stock, re.S)
        return m.group(0) if m else f"<{name} not found>"

    for fn in ("_load_text_encoder", "_load_transformer", "load_model", "_resolve_comfy_file", "_load_vaes"):
        out[f"src:{fn}"] = _func(fn)
    m = re.search(r"\ndef _resolve_comfy_file\(.*?(?=\ndef |\nclass |\Z)", stock, re.S)
    if m:
        out["src:_resolve_comfy_file(module)"] = m.group(0)
    out["src:imports"] = [ln for ln in stock.splitlines()[:80] if ln.startswith(("import", "from"))]

    # TE skeleton (same as _ull_h3_te_load_baked) on the meta device -> its state_dict keys.
    try:
        import sys

        sys.path.insert(0, W.AI_TOOLKIT_DIR)
        # The package __init__ imports every arch (omnigen2 needs CUDA at import), so import only the TE class and
        # read the constants from the source.
        from toolkit.models.v2.text_encoders.qwen3_vl import Qwen3VLTextEncoder

        m_layer = re.search(r"^TEXT_ENCODER_LAYER\s*=\s*(\d+)", stock, re.M)
        m_repo = re.search(r'^ORIGINAL_REPO\s*=\s*"([^"]+)"', stock, re.M)
        ns = {
            "Qwen3VLTextEncoder": Qwen3VLTextEncoder,
            "TEXT_ENCODER_LAYER": int(m_layer.group(1)) if m_layer else 50,
            "ORIGINAL_REPO": m_repo.group(1),
        }
        out["TEXT_ENCODER_LAYER_src"] = m_layer.group(0) if m_layer else None
        from accelerate import init_empty_weights
        from transformers import AutoConfig

        config = AutoConfig.from_pretrained(ns["ORIGINAL_REPO"], subfolder="FL2VA/text_encoder")
        config.text_config.num_hidden_layers = ns["TEXT_ENCODER_LAYER"]
        config.tie_word_embeddings = False
        with init_empty_weights():
            te = ns["Qwen3VLTextEncoder"](config)
        te.lm_head = None
        sk = {k: (str(v.dtype), list(v.shape)) for k, v in te.state_dict().items()}
        out["skeleton"] = {
            "n_keys": len(sk),
            "TEXT_ENCODER_LAYER": ns["TEXT_ENCODER_LAYER"],
            "sample": sorted(sk)[:30],
            "layer0": sorted(k for k in sk if ".layers.0." in k),
        }
        bf16 = [p for p in clip if p.endswith("_bf16.safetensors")]
        if bf16:
            def key_map(prefix: str) -> str:  # same as minimax_h3.py _load_text_encoder
                if prefix.startswith("model."):
                    return "model.language_model." + prefix[len("model.") :]
                if prefix.startswith("visual."):
                    return "model." + prefix
                return prefix

            h0 = _header(bf16[0])
            h = {key_map(k[: k.rfind(".")]) + k[k.rfind(".") :]: v for k, v in h0.items()}
            fk = set(h)
            skk = set(sk)
            out["diff_direct"] = {
                "missing_in_file": sorted(skk - fk)[:40],
                "n_missing": len(skk - fk),
                "unexpected_in_file": sorted(fk - skk)[:40],
                "n_unexpected": len(fk - skk),
            }
            # Shape check on the keys that do line up.
            mism = [
                (k, sk[k][1], h[k]["shape"]) for k in (skk & fk) if list(h[k]["shape"]) != sk[k][1]
            ]
            out["shape_mismatch"] = mism[:20]
            out["n_shape_mismatch"] = len(mism)
            out["dtype_in_file"] = sorted({h[k]["dtype"] for k in fk})
    except Exception as e:  # noqa: BLE001
        import traceback

        out["skeleton_error"] = traceback.format_exc()[-3000:]
    return out


@app.local_entrypoint()
def main():
    import json

    r = probe.remote()
    with open("minimax_bf16_probe_result.json", "w", encoding="utf-8") as f:
        json.dump(r, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: v for k, v in r.items() if not k.startswith(("src:", "hdr:"))}, ensure_ascii=False, indent=1)[:6000])
