-- UI builder: priority-ordered GPU fallback chain per workflow.
--
-- gpu_fallback_list is a JSON array of WorkflowGpuTier ids in descending
-- priority order (e.g. ["b300", "h200", "h100", "a100_80gb"]). The generate
-- route forwards it to Modal so the scheduler can hop to the next GPU when
-- the preferred one is congested / out of capacity. Empty array = no
-- fallback (run only on the workflow's primary GPU). Additive; existing
-- rows default to '[]'.
alter table public.studio_custom_workflows
  add column if not exists gpu_fallback_list jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
