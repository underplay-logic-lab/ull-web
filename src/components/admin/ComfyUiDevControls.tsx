"use client";

import { useState } from "react";
import { Loader2, Square, Wrench } from "lucide-react";

// Persistent (modal deploy, not ephemeral serve) URL for the T4 ComfyUI dev
// GUI — see modal_comfyui_dev.py at the repo root. Hardcoded rather than an
// env var: it's a fixed dev-tool endpoint, not a secret, and only ever
// changes if that app is redeployed under a different name.
const COMFYUI_DEV_URL = "https://axelbh5--ull-comfyui-dev-comfyui-server.modal.run";

// Admin-header pair for the ComfyUI dev GUI: an "open" link plus a "🛑 終了"
// button that force-stops the GPU container without waiting for its idle
// timeout. There's no public Modal API to reach into and kill a running
// container from here — the button instead POSTs to
// /api/admin/modal/comfyui-dev/stop, which forwards to
// modal_comfyui_dev.py's control() endpoint; that just leaves a note in a
// shared modal.Dict, and the running container's own background thread
// notices it within a few seconds and self-terminates.
export function ComfyUiDevControls() {
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const handleStop = async () => {
    setStopping(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/modal/comfyui-dev/stop", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        // Temporary: surface the debug payload inline while tracking down
        // why the env vars aren't reading in production. Remove once resolved.
        const debugText = data?.debug ? ` [${JSON.stringify(data.debug)}]` : "";
        throw new Error((data?.error ?? "終了に失敗しました。") + debugText);
      }
      setNotice({ kind: "success", text: "終了リクエストを送信しました（数秒で停止します）。" });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "終了に失敗しました。" });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <a
        href={COMFYUI_DEV_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="アクセス時にT4 GPUが自動起動します（放置時は自動スリープし、その間の課金はありません）"
        className="flex items-center gap-1.5 rounded-full border border-neon-violet/50 bg-neon-violet/15 px-3 py-1.5 text-xs font-medium text-neon-violet transition-colors hover:bg-neon-violet/25"
      >
        <Wrench size={14} />
        🛠️ クラウドComfyUIを開く
      </a>
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
      {notice && (
        <span className={`text-[11px] ${notice.kind === "success" ? "text-neon-pink" : "text-red-400"}`}>
          {notice.text}
        </span>
      )}
    </div>
  );
}
