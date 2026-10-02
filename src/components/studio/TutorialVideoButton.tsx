"use client";

import { useEffect, useState } from "react";
import { TUTORIAL_VIDEOS } from "@/lib/tutorialVideos";

// タブの説明の下に出す「使い方の動画」。押すとその場で再生する（タブの入力を捨てないよう、ページは移らない）。
export function TutorialVideoButton({ tab, className = "" }: { tab: string; className?: string }) {
  const video = TUTORIAL_VIDEOS[tab];
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!video?.youtubeId) return null;

  return (
    <>
      <p className={`text-[11px] text-muted ${className}`}>
        <button type="button" onClick={() => setOpen(true)} className="underline underline-offset-2 hover:text-foreground">
          ▶ 使い方の動画（{video.length}）
        </button>
      </p>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="使い方の動画"
        >
          <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex justify-end">
              <button type="button" onClick={() => setOpen(false)} className="text-sm text-muted hover:text-foreground">
                閉じる ✕
              </button>
            </div>
            <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
              <iframe
                className="h-full w-full"
                src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?autoplay=1&rel=0`}
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
