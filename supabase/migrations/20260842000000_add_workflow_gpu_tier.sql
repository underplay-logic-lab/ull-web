-- UI builder: per-workflow Modal GPU selection.
--
-- default_gpu_tier is the hardware the workflow's graph runs on
-- (t4 / l4 / a100_40gb / a100_80gb / h100 / b300 — see WORKFLOW_GPU_TIERS in
-- src/lib/customWorkflows.ts). It is passed through to the Modal request as
-- `gpu_tier` by /api/studio/custom-workflows/generate. Independent of the
-- user-facing Standard/ULTRA selector.
--
-- Additive; existing rows default to L4.
alter table public.studio_custom_workflows
  add column if not exists default_gpu_tier text not null default 'l4';
