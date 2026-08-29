-- LoRA Studio: generation_jobs gains a 'lora_training' workflow type plus
-- generic progress / result columns the Modal LoRA worker PATCHes as a
-- training run advances (step count, ETA, and the finished .safetensors
-- path on the Volume).

alter table public.generation_jobs
  drop constraint if exists generation_jobs_workflow_type_check;

alter table public.generation_jobs
  add constraint generation_jobs_workflow_type_check
  check (workflow_type in ('cinematic', 'wan', 'custom', 'lora_training'));

alter table public.generation_jobs
  add column if not exists progress_percent integer,
  add column if not exists progress_message text,
  add column if not exists result_path text;

notify pgrst, 'reload schema';
