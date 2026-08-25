import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";

// Forwards to modal_comfyui_dev.py's control() endpoint, which just leaves
// a note in a shared modal.Dict — the running comfyui_server container (if
// any) notices it within a few seconds and self-terminates. There's no
// public Modal API to force-stop a container from outside, so this
// self-directed-shutdown design is what actually makes a "🛑 終了" button
// possible at all; see the control_dict comment in modal_comfyui_dev.py.
export async function POST() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const url = process.env.MODAL_COMFYUI_DEV_CONTROL_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;

  if (!url || !authToken) {
    // Temporary diagnostics (which var, and its length) to track down why
    // the env vars aren't being picked up in production — never logs the
    // actual secret value. Remove once resolved.
    return NextResponse.json(
      {
        error: "サーバー設定エラーです（Modal未設定）。",
        debug: {
          hasUrl: Boolean(url),
          urlLength: url?.length ?? 0,
          hasAuthToken: Boolean(authToken),
          authTokenLength: authToken?.length ?? 0,
          vercelEnv: process.env.VERCEL_ENV ?? null,
        },
      },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
      body: JSON.stringify({ action: "stop" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Modal request failed (${res.status}): ${text.slice(0, 500)}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/modal/comfyui-dev/stop] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "終了リクエストに失敗しました。" },
      { status: 502 },
    );
  }
}
