-- Optional admin-specified "final output" node id for a Custom Workflow's
-- graph (e.g. a SaveVideo/SaveImage/VHS_VideoCombine node). When set, Modal
-- reads this node's output directly from ComfyUI's /history response
-- instead of falling back to a full scan — see run_custom_workflow /
-- _run_workflow in scripts/modal_wan_animate.py. Empty string means
-- "auto-detect" (the existing fallback behavior, unchanged).
alter table public.studio_custom_workflows
  add column if not exists output_node_id text default '';
