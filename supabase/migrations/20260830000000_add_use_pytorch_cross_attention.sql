-- Fourth ComfyUI runtime/optimization toggle, alongside
-- disable_smart_memory/cpu_vae/gpu_only. Maps to ComfyUI's
-- --use-pytorch-cross-attention flag (PyTorch's own scaled_dot_product_attention,
-- which already includes a flash-attention backend) — used in place of
-- --use-flash-attention because no prebuilt flash-attn wheel exists for
-- this image's Python 3.11 / torch cu130 combination (see
-- _ensure_comfy_running in scripts/modal_wan_animate.py).
alter table public.studio_custom_workflows
  add column if not exists use_pytorch_cross_attention boolean not null default false;
