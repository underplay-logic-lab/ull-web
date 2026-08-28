-- UI builder: fully custom Studio badge text per workflow.
--
-- gpu_badge_label is free text shown on the Studio card / detail header
-- (e.g. "⚡ Logic Core V2"). Empty string = the badge is hidden entirely.
-- Additive; existing rows default to '' (hidden).
alter table public.studio_custom_workflows
  add column if not exists gpu_badge_label text not null default '';
