-- UI builder Phase 1: named layout sections for a custom workflow.
--
-- Each entry in `sections` is
--   { id, label, description?, defaultCollapsed?, minTier? }
-- (see WorkflowSection / isValidWorkflowSections in src/lib/customWorkflows.ts).
-- The per-field 12-column layout (colSpan / row / sectionId / minTier) lives
-- inside the existing input_schema jsonb, so no column is needed for that.
--
-- Additive and backward compatible: existing rows get '[]' and every current
-- input_schema entry keeps rendering full width (colSpan undefined = 12).

alter table public.studio_custom_workflows
  add column if not exists sections jsonb not null default '[]';
