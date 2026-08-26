"""
Patches a local thu-ml/SageAttention checkout (used by
modal_wan_animate_blackwell.py's image build) so it actually compiles and
dispatches a genuine kernel for compute capability 10.3 (sm_103 /
"Blackwell Ultra", i.e. Modal's B300 GPU) instead of silently dropping it.

Two independent gaps exist in the upstream source as of commit
d1a57a546c3d395b1ffcbeecc66d81db76f3b4b5:

1. setup.py's arch-parsing loop only recognizes the "8.0"/"8.6"/"8.9"/"9.0"/
   "10.0"/"12.0"/"12.1" prefixes; "10.3" matches none of them and falls
   through an unconditional `else: continue`, so the built extension
   contains zero compiled code (SASS *or* PTX) for sm_103 no matter what
   TORCH_CUDA_ARCH_LIST says. This is a *build-time* gap, not just a
   dispatch-table one — patching only (2) below without this would trade
   the current clean "Unsupported CUDA architecture" ValueError for an
   opaque "no kernel image is available for execution on the device" CUDA
   error at the first real attention call. Patched here to add a 10.3
   branch that emits `-gencode arch=compute_103a,code=sm_103a` — the same
   family-specific ("a"-suffixed) naming this file already uses for
   sm90a/sm100a/sm120a/sm121a, so nvcc compiles genuine native sm_103a SASS
   into the same extension.

2. sageattention/core.py's sageattn() Python dispatcher separately has no
   "sm100" *or* "sm103" branch (this library doesn't support Wan/Blackwell-
   datacenter chips out of the box at all yet, at either build or dispatch
   level) — even with (1) applied, calling sageattn() on a real B300 would
   still hit the `else: raise ValueError("Unsupported CUDA architecture:
   sm103")` fallback. Patched to route sm100/sm103 through the same
   wrapper function already used for sm120 (the nearest architecturally-
   equivalent branch actually implemented: same 5th-gen tensor core
   generation, accurate fp32-accumulator FP8 CUDA kernel, no triton
   backend). Because of patch (1), that wrapper now launches real,
   natively-compiled sm_103a SASS on a B300 — not a cross-architecture
   substitute.

Usage:
    python3 patch_sageattention_blackwell_ultra.py <path-to-SageAttention-checkout>

Exits non-zero (failing the image build loudly) if either target string
isn't found exactly once — e.g. because upstream restructured the file —
rather than silently no-op'ing and shipping an image that looks patched but
isn't.
"""

import pathlib
import sys


def _patch(path: pathlib.Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"[patch_sageattention_blackwell_ultra] {label}: expected exactly 1 match "
            f"in {path}, found {count}. Upstream source has likely changed since this "
            f"patch was written against commit d1a57a546c3d395b1ffcbeecc66d81db76f3b4b5 "
            f"— update the patch before deploying."
        )
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"[patch_sageattention_blackwell_ultra] {label}: patched {path}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch_sageattention_blackwell_ultra.py <sageattention-checkout-dir>")
    root = pathlib.Path(sys.argv[1])

    _patch(
        root / "setup.py",
        old=(
            '        elif capability.startswith("10.0"):\n'
            '            HAS_SM100 = True\n'
            '            num = "100a"\n'
            '        elif capability.startswith("12.0"):'
        ),
        new=(
            '        elif capability.startswith("10.0"):\n'
            '            HAS_SM100 = True\n'
            '            num = "100a"\n'
            '        elif capability.startswith("10.3"):\n'
            '            HAS_SM100 = True\n'
            '            num = "103a"\n'
            '        elif capability.startswith("12.0"):'
        ),
        label="setup.py arch table (add sm_103a build target)",
    )

    _patch(
        root / "sageattention" / "core.py",
        old=(
            '    else:\n'
            '        raise ValueError(f"Unsupported CUDA architecture: {arch}")'
        ),
        new=(
            '    elif arch in ("sm100", "sm103"):\n'
            '        # ULL Blackwell Ultra compat patch: sm100/sm103 have no dedicated\n'
            '        # branch here upstream; routed onto the sm120 wrapper (same 5th-gen\n'
            '        # tensor core family, accurate fp32-accumulator FP8 CUDA kernel).\n'
            '        # The setup.py patch applied alongside this one makes the extension\n'
            '        # actually contain compiled sm_103a SASS, so this launches genuine\n'
            '        # B300-native code, not a cross-architecture substitute.\n'
            '        return sageattn_qk_int8_pv_fp8_cuda(q, k, v, tensor_layout=tensor_layout, is_causal=is_causal, qk_quant_gran="per_warp", sm_scale=sm_scale, return_lse=return_lse, pv_accum_dtype="fp32+fp16")\n'
            '    else:\n'
            '        raise ValueError(f"Unsupported CUDA architecture: {arch}")'
        ),
        label="core.py sageattn() dispatch (add sm100/sm103 branch)",
    )

    # Startup confirmation, printed once at import time (not per-call —
    # the patch's presence doesn't depend on which GPU shows up at
    # runtime, so there's nothing to gate it on).
    _patch(
        root / "sageattention" / "core.py",
        old="def get_cuda_arch_versions():",
        new=(
            'print("[INFO] SageAttention Blackwell Ultra compat patch active: '
            'sm100/sm103 dispatch via the sm120 path, sm_103a kernels compiled natively.")\n\n\n'
            'def get_cuda_arch_versions():'
        ),
        label="core.py startup log line",
    )


if __name__ == "__main__":
    main()
