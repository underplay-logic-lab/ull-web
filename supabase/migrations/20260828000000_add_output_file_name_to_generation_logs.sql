-- Volume-relative path (e.g. "outputs/all/<uuid>_<filename>.mp4") of every
-- generation's output, saved by Modal's _save_output_temp for up to 7 days
-- (see cleanup_old_outputs in scripts/modal_wan_animate.py) purely so an
-- admin can preview it from the Admin logs UI.
alter table public.generation_logs
  add column if not exists output_file_name text not null default '';
