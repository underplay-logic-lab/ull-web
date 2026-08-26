"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Square, Wrench } from "lucide-react";

// How often the status badge re-checks on its own — cheap (the status
// check hits a GPU-less control-plane function, never the GPU itself), so
// a short interval is fine.
const STATUS_POLL_INTERVAL_MS = 8000;

function formatRunningSince(runningSince: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor(now / 1000 - runningSince));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}時間${minutes % 60}分`;
  }
  return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
}

// Admin-header trio for the ComfyUI dev GUI: an "open" link, a live
// running/stopped status badge, and a "🛑 終了" button that force-stops the
// GPU container without waiting for its idle timeout. There's no public
// Modal API to reach into and list/kill a running container from here —
// both the status check and the stop button instead talk to
// modal_comfyui_dev.py's control() endpoint, which reads/writes a shared
// modal.Dict that the running container's own background thread maintains
// (a heartbeat for status, a stop-request flag for the kill switch).
export function ComfyUiDevControls() {
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const [status, setStatus] = useState<{ running: boolean; runningSince: number | null } | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const checkStatus = async () => {
    setStatusLoading(true);
    try {
      const res = await fetch("/api/admin/modal/comfyui-dev/status");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "状態確認に失敗しました。");
      setStatus({ running: Boolean(data.running), runningSince: data.runningSince ?? null });
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "状態確認に失敗しました。");
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    // Deferred rather than called directly in the effect body (React's
    // set-state-in-effect lint rule flags synchronous setState calls
    // there) — fires on the next tick instead of waiting for the first
    // interval tick below.
    const initialId = setTimeout(checkStatus, 0);
    const intervalId = setInterval(checkStatus, STATUS_POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initialId);
      clearInterval(intervalId);
    };
  }, []);

  // Local 1s ticker for the running-duration display — status.runningSince
  // itself only changes when the container actually starts/stops.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Opens the launch-loading relay page (src/app/admin/comfyui-loading)
  // instead of the ComfyUI URL itself or a warmed-up "about:blank" tab — a
  // previous revision redirected as soon as a warm-up fetch merely
  // *settled* (success or failure) or after a few seconds, whichever came
  // first, which fired well before a cold T4 GPU actually finished booting
  // ComfyUI and landed the admin on Modal's own "still cold" error page.
  // The loading page instead polls this app's own status API for a real
  // readiness flag and only navigates once that comes back true. A plain
  // window.open() to a real URL is a synchronous, direct result of this
  // click, so there's no popup-blocker concern the way an awaited redirect
  // would have.
  const handleLaunch = () => {
    window.open("/admin/comfyui-loading", "_blank");
  };

  const handleStop = async () => {
    setStopping(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/modal/comfyui-dev/stop", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "終了に失敗しました。");
      setNotice({ kind: "success", text: "終了リクエストを送信しました（数秒で停止します）。" });
      checkStatus();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "終了に失敗しました。" });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={handleLaunch}
        title="アクセス時にT4 GPUが自動起動します（放置時は自動スリープし、その間の課金はありません）"
        className="flex items-center gap-1.5 rounded-full border border-neon-violet/50 bg-neon-violet/15 px-3 py-1.5 text-xs font-medium text-neon-violet transition-colors hover:bg-neon-violet/25"
      >
        <Wrench size={14} />
        🛠️ クラウドComfyUIを開く
      </button>

      <button
        type="button"
        onClick={checkStatus}
        disabled={statusLoading}
        title="今すぐ状態を再確認します"
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          status?.running
            ? "border-green-500/40 bg-green-500/10 text-green-400 hover:bg-green-500/20"
            : "border-border bg-surface/60 text-muted hover:border-neon-violet/40 hover:text-foreground"
        }`}
      >
        {statusLoading ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <RefreshCw size={14} />
        )}
        {status === null
          ? "状態確認中..."
          : status.running
            ? `🟢 稼働中（起動から${status.runningSince !== null ? formatRunningSince(status.runningSince, now) : "?"}）`
            : "⚫ 停止中"}
      </button>

      <button
        type="button"
        onClick={handleStop}
        disabled={stopping}
        title="起動中のComfyUI開発用GPUコンテナを即座に終了します"
        className="flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {stopping ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
        🛑 終了
      </button>

      {(notice || statusError) && (
        <span className={`text-[11px] ${notice?.kind === "error" || statusError ? "text-red-400" : "text-neon-pink"}`}>
          {notice?.text ?? statusError}
        </span>
      )}
    </div>
  );
}
