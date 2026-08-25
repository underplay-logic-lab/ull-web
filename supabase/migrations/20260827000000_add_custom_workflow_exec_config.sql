-- Per-workflow ComfyUI runtime/memory optimization settings, editable from
-- the admin Custom Workflow editor. These map directly to ComfyUI CLI flags
-- (--disable-smart-memory, --cpu-vae, --gpu-only, plus arbitrary extra
-- flags) that Modal applies by restarting the ComfyUI process for a
-- workflow whose requested settings differ from what's currently running
-- (see _ensure_comfy_running in scripts/modal_wan_animate.py) — these are
-- process-startup-only flags in ComfyUI, so there is no way to apply them
-- to an already-running process.
alter table public.studio_custom_workflows
  add column if not exists disable_smart_memory boolean not null default false,
  add column if not exists cpu_vae boolean not null default false,
  add column if not exists gpu_only boolean not null default false,
  add column if not exists extra_args text not null default '';
