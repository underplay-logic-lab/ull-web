"use client";

import { useEffect, useState } from "react";
import { TUTORIAL_VIDEOS, type TutorialVideo } from "@/lib/tutorialVideos";

// タブの説明の下に出す「使い方の動画」。押すとその場で再生する（タブの入力を捨てないよう、ページは移らない）。
// 1 つのタブに複数本あるときは、ボタンを横に並べる（label で見分ける）。
export function TutorialVideoButton({ tab, className = "" }: { tab: string; className?: string }) {
  const videos = (TUTORIAL_VIDEOS[tab] ?? []).filter((v) => v.youtubeId);
  const [open, setOpen] = useState<TutorialVideo | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (videos.length === 0) return null;

  return (
    <>
      <p className={`flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted ${className}`}>
        {videos.map((v) => (
          <button
            key={v.youtubeId}
            type="button"
            onClick={() => setOpen(v)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            ▶ 使い方の動画{videos.length > 1 && v.label ? `「${v.label}」` : ""}（{v.length}）
          </button>
        ))}
      </p>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(null)}
          role="dialog"
          aria-modal="true"
          aria-label="使い方の動画"
        >
          <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex justify-end">
              <button type="button" onClick={() => setOpen(null)} className="text-sm text-muted hover:text-foreground">
                閉じる ✕
              </button>
            </div>
            <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
              <iframe
                className="h-full w-full"
                src={`https://www.youtube-nocookie.com/embed/${open.youtubeId}?autoplay=1&rel=0`}
                title="使い方の動画"
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
