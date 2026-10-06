"""ScragVAE（scragnog/Ace-Step-1.5-ScragVAE・MIT・rev 0547ba3）を ComfyUI で読める形に変換する（2026-10-06）。

diffusers の AutoencoderOobleck の名前 → ComfyUI（stable-audio 形式）の名前。公式 VAE の diffusers 版
（ACE-Step/Ace-Step1.5 rev 19671f4 の vae/）を変換して ComfyUI 版（Comfy-Org/ace_step_1.5_ComfyUI_files の
split_files/vae/ace_1.5_vae.safetensors）と 365 個すべて値まで一致することを確かめてから、同じ表で ScragVAE を変換する。
Snake の alpha / beta は diffusers が [1, C, 1]・ComfyUI が [C]。精度は公式 ComfyUI 版と同じ BF16。

使い方（3 つのファイルを同じフォルダに落としてから）:
  python ace_scragvae_convert.py ace_1.5_scragvae_bf16.safetensors
  MSYS_NO_PATHCONV=1 modal volume put ull-wan-models ace_1.5_scragvae_bf16.safetensors /ace_step/vae/ace_1.5_scragvae_bf16.safetensors
  （Git Bash では MSYS_NO_PATHCONV=1 が無いと Volume 上のパスが C:/Program Files/Git/... に書き換わる）
"""
import re, sys, torch
from safetensors.torch import load_file, save_file

def nblocks(keys, side):
    return 1 + max(int(m.group(1)) for k in keys if (m := re.match(rf"{side}\.block\.(\d+)\.", k)))

def mapname(k, nb):
    m = re.match(r"(encoder|decoder)\.(.*)", k); side, rest = m.groups()
    if rest.startswith("conv1."): return f"{side}.layers.0.{rest[6:]}"
    if rest.startswith("snake1."): return f"{side}.layers.{nb[side] + 1}.{rest[7:]}"
    if rest.startswith("conv2."): return f"{side}.layers.{nb[side] + 2}.{rest[6:]}"
    m = re.match(r"block\.(\d+)\.(.*)", rest); i, sub = int(m.group(1)), m.group(2)
    L = f"{side}.layers.{i + 1}.layers"
    m = re.match(r"res_unit(\d)\.(snake1|conv1|snake2|conv2)\.(.*)", sub)
    if m:
        u, part, tail = int(m.group(1)), m.group(2), m.group(3)
        pos = (u - 1) if side == "encoder" else (u + 1)
        return f"{L}.{pos}.layers.{['snake1','conv1','snake2','conv2'].index(part)}.{tail}"
    m = re.match(r"(snake1|conv1|conv_t1)\.(.*)", sub)
    part, tail = m.groups()
    if side == "encoder":
        return f"{L}.{3 if part == 'snake1' else 4}.{tail}"
    return f"{L}.{0 if part == 'snake1' else 1}.{tail}"

def convert(sd):
    nb = {s: nblocks(sd, s) for s in ("encoder", "decoder")}
    out = {}
    for k, v in sd.items():
        n = mapname(k, nb)
        # Snake の alpha / beta は diffusers が [1, C, 1]、ComfyUI が [C]（値は同じ）。
        out[n] = v.reshape(-1) if n.endswith((".alpha", ".beta")) else v
    return out

off = convert(load_file("official_diffusers.safetensors"))
ref = load_file("comfy_official.safetensors")
print("keys equal:", set(off) == set(ref), "missing:", list(set(ref) - set(off))[:3], "extra:", list(set(off) - set(ref))[:3])
bad = [k for k in ref if k in off and (off[k].shape != ref[k].shape or not torch.allclose(off[k].float(), ref[k].float(), atol=1e-2, rtol=1e-2))]
print("value mismatches:", len(bad), bad[:3])
if set(off) == set(ref) and not bad and len(sys.argv) > 1:
    sc = convert(load_file("scrag_diffusers.safetensors"))
    assert set(sc) == set(ref)
    save_file({k: v.to(ref[k].dtype).contiguous() for k, v in sc.items()}, sys.argv[1])
    print("wrote", sys.argv[1])
