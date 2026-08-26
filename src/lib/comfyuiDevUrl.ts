// Shared by ComfyUiDevControls.tsx (the launch button) and
// src/app/admin/comfyui-loading/page.tsx (the relay page it opens) so both
// ever only need to agree on one URL. Reads NEXT_PUBLIC_MODAL_COMFYUI_DEV_URL
// when set, falling back to the known-stable deployed URL (see
// modal_comfyui_dev.py at the repo root) — it's a fixed dev-tool endpoint,
// not a secret, and only ever changes if that Modal app is redeployed under
// a different name, so requiring the env var isn't worth the risk of this
// silently breaking in an environment that hasn't set it.
export const COMFYUI_DEV_URL =
  process.env.NEXT_PUBLIC_MODAL_COMFYUI_DEV_URL || "https://axelbh5--ull-comfyui-dev-comfyui-server.modal.run";
