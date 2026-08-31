-- LoRA Studio: the Modal worker streams a small telemetry/result blob into
-- generation_jobs.metadata as a run advances — currently the live effective
-- VRAM figure (vram_used_gb) shown as a spoiler-free badge, and, on
-- completion, the list of intermediate LoRA checkpoints persisted to the
-- Volume under loras/<user_id>/<job_id>/ so the user can pick the least
-- over-fit step to download.

alter table public.generation_jobs
  add column if not exists metadata jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
