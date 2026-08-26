import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";

// Forwards to modal_comfyui_dev.py's control() endpoint's "status" action,
// which reports whether comfyui_server's background thread has written a
// heartbeat within HEARTBEAT_STALE_AFTER_SECONDS — the only way to tell
// "is the GPU container actually alive right now" from outside, since
// Modal exposes no public container-list API. `running` only means the
// container function has started (the heartbeat thread starts before the
// ComfyUI subprocess is even spawned) — `ready` is the stronger signal
// that ComfyUI itself finished booting and is actually serving HTTP (see
// READY_AT_KEY in modal_comfyui_dev.py), which is what the launch-loading
// page (src/app/admin/comfyui-loading/page.tsx) polls for.
export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const url = process.env.MODAL_COMFYUI_DEV_CONTROL_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;

  if (!url || !authToken) {
    return NextResponse.json({ error: "サーバー設定エラーです（Modal未設定）。" }, { status: 500 });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
      body: JSON.stringify({ action: "status" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Modal request failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    return NextResponse.json({
      running: Boolean(data.running),
      runningSince: data.running_since ?? null,
      ready: Boolean(data.ready),
    });
  } catch (err) {
    console.error("[admin/modal/comfyui-dev/status] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "状態確認に失敗しました。" },
      { status: 502 },
    );
  }
}
