-- Fifth ComfyUI runtime/optimization toggle, alongside
-- disable_smart_memory/cpu_vae/gpu_only/use_pytorch_cross_attention. Maps to
-- ComfyUI's --highvram flag, which keeps loaded models resident in VRAM
-- across runs instead of offloading them between nodes (see
-- _ensure_comfy_running in scripts/modal_wan_animate.py).
alter table public.studio_custom_workflows
  add column if not exists high_vram boolean not null default false;
