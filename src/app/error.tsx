"use client";

import { useEffect } from "react";

/**
 * Route-segment error boundary for the home page (and every other page under
 * app/). A thrown client-component error lands here as a recoverable card —
 * "reset()" re-renders the segment in place. It never reloads the page or
 * navigates away, so a transient render error can't bounce the user to "/".
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/error] boundary caught:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-lg font-semibold text-foreground">
        画面の描画中に問題が発生しました
      </p>
      <p className="max-w-md text-sm text-muted">
        入力内容は保持されています。下のボタンで再表示してください。解消しない場合はページを再読み込みしてください。
      </p>
      {process.env.NODE_ENV === "development" && error?.message ? (
        <pre className="max-w-lg overflow-x-auto rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-left text-[11px] text-red-400">
          {error.message}
        </pre>
      ) : null}
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90"
      >
        再表示する
      </button>
    </div>
  );
}
