"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Wrench } from "lucide-react";
import { COMFYUI_DEV_URL } from "@/lib/comfyuiDevUrl";

// How often this polls the same-origin status API (see status/route.ts) for
// the "ready" flag while this page is mounted. This is the *only* place in
// the admin app allowed to do this — status/route.ts only runs its
// GPU-hitting readiness probe when called with ?probe=1, and this is the
// only caller that ever passes it, specifically so routine/automatic
// polling elsewhere (e.g. the admin header's status badge) can never
// accidentally wake the container.
const POLL_INTERVAL_MS = 2000;

// Past this, a cold T4 + ComfyUI boot is taking unusually long (or genuinely
// failed) — stop auto-polling and hand the admin a manual way forward
// instead of spinning forever.
const TIMEOUT_MS = 40_000;

// Deliberately NOT how readiness is detected here (see below) — this fires
// once on mount purely to trigger Modal's scale-from-zero for the GPU web
// endpoint. A `fetch` with `mode: "no-cors"` against a cross-origin URL
// resolves (doesn't throw) for both a real 200 AND an HTTP error response
// like the 403 Modal's own edge can return while a container is still
// cold — it only *rejects* on an actual network-level failure. That opacity
// makes it useless as a readiness signal from the browser. Readiness
// instead comes from polling this app's own /api/admin/modal/comfyui-dev/
// status, which runs its own real HTTP probe server-side (Node has no CORS
// restriction, so it can just read the actual status code — see that
// route for why this no longer trusts modal_comfyui_dev.py's Dict-based
// ready flag alone).
function triggerWarmup() {
  fetch(COMFYUI_DEV_URL, { mode: "no-cors" }).catch(() => {});
}

// window.location.href sends a Referer header on the resulting cross-origin
// request; Modal's proxy has been observed rejecting the dev GPU URL when
// one is present. A synthetic <a rel="noreferrer"> click navigates the same
// way (target="_self" keeps it in this tab) without ever sending one.
function navigateNoReferrer(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noreferrer";
  a.target = "_self";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function ComfyUiLoadingPage() {
  const [timedOut, setTimedOut] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  // Tracks whichever setTimeout is currently pending so the effect cleanup
  // can clear it outright (rather than only relying on the `cancelled`
  // flag to no-op a poll that still fires after unmount) — this is a
  // recursive setTimeout chain rather than setInterval specifically so
  // each next poll can only ever be scheduled after the previous one's
  // fetch has fully settled, never overlapping it.
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    startedAtRef.current = Date.now();
    triggerWarmup();

    const poll = async () => {
      if (cancelled) return;
      try {
        // ?probe=1 is what tells status/route.ts to actually reach out to
        // the ComfyUI URL for a real readiness check — see that route and
        // the POLL_INTERVAL_MS comment above for why every other caller in
        // this app must never pass it.
        const res = await fetch("/api/admin/modal/comfyui-dev/status?probe=1", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;

        if (res.ok && data?.ready) {
          navigateNoReferrer(COMFYUI_DEV_URL);
          return;
        }
        setCheckError(null);
      } catch (err) {
        if (!cancelled) setCheckError(err instanceof Error ? err.message : "状態確認に失敗しました。");
      }

      if (cancelled) return;
      if (Date.now() - (startedAtRef.current ?? Date.now()) >= TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }
      // Re-fires the warm-up request alongside every poll tick too — a
      // single fire-and-forget on mount could in principle race with a
      // container that was already mid-shutdown, so repeating it costs
      // nothing and closes that gap.
      triggerWarmup();
      timeoutIdRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timeoutIdRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeoutIdRef.current !== null) clearTimeout(timeoutIdRef.current);
    };
  }, []);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 py-16 text-center">
      <style>{`
        @keyframes comfyui-loading-sweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
      `}</style>

      <div className="w-full max-w-md rounded-2xl border-gradient bg-surface/60 p-8">
        {!timedOut ? (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-neon-violet/40 bg-neon-violet/10">
              <Wrench size={24} className="text-neon-violet" />
            </div>

            <h1 className="mt-5 text-lg font-bold text-foreground">
              🛠️ クラウドComfyUI（T4）を起動しています...
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              ※ GPUスピンアップと環境初期化に15〜20秒ほどかかります。完了次第、自動的に接続します。
            </p>

            <div className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-background">
              <div
                className="h-full w-1/3 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet"
                style={{ animation: "comfyui-loading-sweep 1.4s ease-in-out infinite" }}
              />
            </div>

            {checkError && (
              <p className="mt-4 text-xs text-muted">
                （状態確認が一時的に失敗していますが、起動処理は継続しています: {checkError}）
              </p>
            )}
          </>
        ) : (
          <>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10">
              <AlertTriangle size={24} className="text-amber-400" />
            </div>

            <h1 className="mt-5 text-lg font-bold text-foreground">起動に時間がかかっています</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              予想より起動に時間がかかっているようです。GPUの空き待ちなどが原因の場合があります。
              下のボタンから手動で開くか、しばらくしてからもう一度お試しください。
            </p>

            <a
              href={COMFYUI_DEV_URL}
              rel="noreferrer"
              className="mt-6 flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              <ExternalLink size={15} />
              手動で開く
            </a>
          </>
        )}
      </div>
    </div>
  );
}
