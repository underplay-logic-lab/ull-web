import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { COMFYUI_DEV_URL } from "@/lib/comfyuiDevUrl";

// How long to wait for the ComfyUI dev GPU's own HTTP response before
// treating it as "not ready yet" — this is a liveness probe fired every
// couple seconds by the launch-loading page, not a real request, so it
// must fail fast rather than hang the whole status check.
const PROBE_TIMEOUT_MS = 3000;

// The launch-loading page (src/app/admin/comfyui-loading/page.tsx) used to
// trust modal_comfyui_dev.py's own READY_AT_KEY Dict flag (compared against
// RUNNING_SINCE_KEY to reject stale values from a previous container
// generation) — but that comparison is wall-clock timestamps written by
// whatever physical host each container generation happened to land on,
// and Modal containers routinely land on different hosts across restarts.
// Clock skew between those hosts can make a *stale* previous generation's
// ready_at read as newer than the *new* generation's running_since,
// producing exactly the instant-false-"ready" flying-redirect bug this is
// meant to prevent. A server-side HTTP probe sidesteps all of that: unlike
// a browser fetch (which in no-cors mode can't read the status of a
// cross-origin response at all — a 403 and a 200 look identical), this
// runs in Node.js with no CORS restriction whatsoever, so it can just read
// the real status code directly. Only a literal 200 counts as ready.
async function probeComfyUiReady(): Promise<boolean> {
  try {
    const res = await fetch(COMFYUI_DEV_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  // The GPU-hitting probe below is opt-in (?probe=1) and used *only* by the
  // launch-loading page (src/app/admin/comfyui-loading/page.tsx) while an
  // admin is actively waiting for the container to come up. Every other
  // caller — most importantly ComfyUiDevControls.tsx's admin-header status
  // badge — must never trigger it: a request to the ComfyUI URL wakes
  // Modal's scale-to-zero container regardless of the response status, so
  // probing it on routine/automatic polling would itself keep bouncing the
  // GPU up (this is exactly how a previous revision of this route caused
  // the container to spin up repeatedly just from the admin page being
  // open, before that badge polling was removed and this was made opt-in).
  const shouldProbe = new URL(request.url).searchParams.get("probe") === "1";
  const ready = shouldProbe ? await probeComfyUiReady() : false;

  const url = process.env.MODAL_COMFYUI_DEV_CONTROL_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;

  if (!url || !authToken) {
    // A genuine misconfiguration (unlike a transient control-plane call
    // failure below) — still worth erroring loudly for the admin header's
    // status badge, but `ready` (needed by the loading page's redirect
    // decision) is included regardless since it never depended on these.
    return NextResponse.json(
      { error: "サーバー設定エラーです（Modal未設定）。", running: false, runningSince: null, ready },
      { status: 500 },
    );
  }

  // Auxiliary only, from here down: modal_comfyui_dev.py's control()
  // "status" action reports whether comfyui_server's background thread has
  // written a heartbeat recently — used solely for the admin header's
  // "🟢 稼働中（起動から…）" badge, not for the loading page's redirect
  // decision above, since it can't tell "container function has started"
  // from "ComfyUI is actually serving HTTP" (the heartbeat thread starts
  // before the ComfyUI subprocess is even spawned).
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
      ready,
    });
  } catch (err) {
    console.error("[admin/modal/comfyui-dev/status] control-plane check failed (non-fatal for `ready`):", err);
    return NextResponse.json({ running: false, runningSince: null, ready });
  }
}
