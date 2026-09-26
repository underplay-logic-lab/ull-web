"use client";

import { useEffect, useState } from "react";
import { Loader2, Layers } from "lucide-react";
import { pollLoraJob, type LoraJobStatus } from "@/lib/loraApi";

// 並列で出した学習のうち、今この画面で追っていないもの（2026-09-26、ホスト判断で LoRA も並列可に）。
// 進行状況パネルは 1 本ずつなので、残りはここに並べて「表示する」で切り替える。

export type BackgroundLoraJob = { jobId: string; label: string };

export const LORA_BACKGROUND_JOBS_KEY = "ull_lora_background_jobs";

export function loadBackgroundLoraJobs(): BackgroundLoraJob[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LORA_BACKGROUND_JOBS_KEY) || "[]") as unknown;
    return Array.isArray(raw)
      ? raw.filter(
          (j): j is BackgroundLoraJob =>
            !!j && typeof (j as BackgroundLoraJob).jobId === "string" && typeof (j as BackgroundLoraJob).label === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function saveBackgroundLoraJobs(jobs: BackgroundLoraJob[]) {
  try {
    localStorage.setItem(LORA_BACKGROUND_JOBS_KEY, JSON.stringify(jobs.slice(-10)));
  } catch {
    /* storage disabled */
  }
}

const POLL_MS = 20_000;

function statusText(s: LoraJobStatus | undefined): string {
  if (!s) return "確認中…";
  switch (s.status) {
    case "queued":
      return "起動準備中";
    case "processing":
      return s.progressPercent != null ? `学習中 ${s.progressPercent}%` : "学習中";
    case "completed":
      return "完了";
    case "cancelled":
      return "中断（返金済み）";
    case "failed_timeout":
      return "開始できませんでした";
    default:
      return "失敗";
  }
}

export function LoraBackgroundJobs({
  jobs,
  onShow,
  onDismiss,
}: {
  jobs: BackgroundLoraJob[];
  onShow: (job: BackgroundLoraJob) => void;
  onDismiss: (jobId: string) => void;
}) {
  const [statuses, setStatuses] = useState<Record<string, LoraJobStatus | undefined>>({});
  const idsKey = jobs.map((j) => j.jobId).join(",");

  useEffect(() => {
    if (!idsKey) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const ids = idsKey.split(",");
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await pollLoraJob(id)] as const;
          } catch {
            return [id, undefined] as const;
          }
        }),
      );
      if (stopped) return;
      setStatuses((prev) => {
        const next = { ...prev };
        for (const [id, s] of results) if (s) next[id] = s;
        return next;
      });
      const anyRunning = results.some(([, s]) => !s || s.status === "queued" || s.status === "processing");
      if (anyRunning) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [idsKey]);

  if (jobs.length === 0) return null;
  return (
    <div className="space-y-2 rounded-xl border border-neon-violet/40 bg-neon-violet/5 p-3">
      <p className="flex items-center gap-2 text-[12px] font-semibold text-neon-violet">
        <Layers size={14} />
        並列で出した学習（{jobs.length} 件）
      </p>
      <ul className="space-y-1.5">
        {jobs.map((j) => {
          const s = statuses[j.jobId];
          const running = !s || s.status === "queued" || s.status === "processing";
          return (
            <li key={j.jobId} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className="flex min-w-0 items-center gap-1.5 text-foreground">
                {running && <Loader2 size={12} className="shrink-0 animate-spin text-neon-violet" />}
                <span className="truncate">{j.label || j.jobId.slice(0, 8)}</span>
                <span className="shrink-0 text-muted">— {statusText(s)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onShow(j)}
                  className="rounded-lg border border-neon-violet/50 px-2.5 py-1 text-[11px] font-semibold text-neon-violet hover:bg-neon-violet/10"
                >
                  {s?.status === "completed" ? "成果物を見る" : "表示する"}
                </button>
                {!running && (
                  <button
                    type="button"
                    onClick={() => onDismiss(j.jobId)}
                    className="rounded-lg border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground"
                  >
                    閉じる
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
