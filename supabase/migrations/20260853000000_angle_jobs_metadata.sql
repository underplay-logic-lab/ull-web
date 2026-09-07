-- Multi-Angle Studio: give angle_jobs a metadata blob, mirroring
-- generation_jobs.metadata (20260851000000). modal_angle_worker.py streams
-- the live effective VRAM figure here (metadata.vram_used_gb) as a run
-- advances; angleApi.pollAngleJob reads it back for the spoiler-free
-- "Active VRAM" badge (no total / %, no GPU model — CLAUDE.md §2).

alter table public.angle_jobs
  add column if not exists metadata jsonb not null default '{}'::jsonb;

notify pgrst, 'reload schema';
