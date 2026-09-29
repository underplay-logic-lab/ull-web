"use client";

// 参照づくり（2026-09-27、ホスト構想「1 枚から素材一式」の段階 1・3）。
// 候補を数枚作り、ユーザーが 1 枚選ぶ。選んだ画像が以後の「基準の全身」や「後ろ姿・真横の参照」になる。
// 生成した画像を次の参照に使うのはここだけ（まとめて生成では確定した参照だけを毎回使う）。
// 候補は素材づくりと同じジョブ（angle_jobs・scene 経路・メイン 1 枚・1 枚 14C）。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, RefreshCw, Sparkles, ZoomIn } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import {
  AngleJobNotFoundError,
  fetchAngleImageBlob,
  pollAngleJob,
  startAngleJob,
  type AngleApiError,
  type AngleJob,
} from "@/lib/angleApi";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { AngleLightbox, useObjectUrl, type LightItem } from "@/components/studio/MultiAngleStudioTab";
import { broadcastCreditsUpdate } from "@/hooks/useProfileCredits";

export type CandidateSpec = { instruction: string; label: string };

/**
 * タブ内で GPU ジョブを 1 本ずつ流すための鍵（2026-09-27）。候補づくりと本生成が同時に走ると、コンテナが 2 台
 * 立ち上がって起動待ちも 2 回になる（並列は追加料金の対象、CLAUDE.md §6-7）。順番に流せば 2 本目は温かいまま始まる。
 */
export type GpuLock = { acquire: () => Promise<() => void> };

class GpuLockImpl implements GpuLock {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.tail;
    this.tail = prev.then(() => mine);
    return prev.then(() => release);
  }
}

export function createGpuLock(): GpuLock {
  return new GpuLockImpl();
}
export type CandidatePick = { jobId: string; index: number };

const IDENTITY = "Keep the same character with the identical face, hairstyle, body shape and clothing as the reference.";
const CANDIDATE_COUNT = 4;

export const FULL_BODY_SPECS: CandidateSpec[] = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
  instruction: `A full body shot showing the whole body from head to feet, standing upright, facing the viewer, against a plain white background. ${IDENTITY}`,
  label: `全身の候補 ${i + 1}`,
}));
export const BACK_VIEW_SPECS: CandidateSpec[] = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
  instruction: `A full body shot seen directly from behind (back view), standing upright, against a plain white background. The hairstyle and the outfit must be consistent with the reference. ${IDENTITY}`,
  label: `後ろ姿の候補 ${i + 1}`,
}));
export const SIDE_VIEW_SPECS: CandidateSpec[] = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
  instruction: `A full body shot in profile view from the side, standing upright, against a plain white background. The hairstyle and the outfit must be consistent with the reference. ${IDENTITY}`,
  label: `真横の候補 ${i + 1}`,
}));

type Status = "idle" | "queued" | "submitting" | "running" | "done" | "error";
const POLL_MS = 2_000;

export async function candidateToFile(jobId: string, index: number, url: string, name: string): Promise<File> {
  const blob = await fetchAngleImageBlob(jobId, index, url);
  return new File([blob], name, { type: blob.type || "image/png" });
}

function downloadBlobUrl(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 候補ジョブ 1 本を回す。jobId は storageKey に保存し、リロード後も候補を出し直す。 */
function useCandidateJob(storageKey: string) {
  const [jobId, setJobId] = useState<string | null>(() => loadFormState<{ jobId: string }>(storageKey)?.jobId || null);
  const [job, setJob] = useState<AngleJob | null>(null);
  const [status, setStatus] = useState<Status>(() => (jobId ? "running" : "idle"));
  const [error, setError] = useState<string | null>(null);
  // 鍵の解放関数。ジョブが終端に達したとき（ポーリング内）に呼ぶ。effect より前に宣言しておく。
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!jobId || status !== "running") return;
    let cancelled = false;
    let errorStreak = 0;
    (async () => {
      while (!cancelled) {
        try {
          const next = await pollAngleJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);
          if (next.status === "completed" || next.status === "failed") {
            releaseRef.current?.();
            releaseRef.current = null;
            if (next.status === "completed") {
              setStatus("done");
            } else {
              setError(next.errorMessage || "候補の生成に失敗しました。");
              setStatus("error");
            }
            return;
          }
        } catch (err) {
          if (cancelled) return;
          if (err instanceof AngleJobNotFoundError) {
            releaseRef.current?.();
            releaseRef.current = null;
            setError("候補のジョブが見つかりませんでした。作り直してください。");
            setStatus("error");
            saveFormState(storageKey, { jobId: "" });
            return;
          }
          errorStreak += 1;
          if (errorStreak >= 8) {
            releaseRef.current?.();
            releaseRef.current = null;
            setError("進捗の取得に繰り返し失敗しました。");
            setStatus("error");
            return;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, status, storageKey]);

  const start = useCallback(
    async (user: User, image: File, specs: CandidateSpec[], lock?: GpuLock, aspect?: "portrait") => {
      setStatus("queued");
      setError(null);
      setJob(null);
      if (lock) releaseRef.current = await lock.acquire();
      setStatus("submitting");
      try {
        const res = await startAngleJob({
          userId: user.id,
          image,
          subImages: [],
          selection: { azimuths: [], elevations: [], distances: [] },
          mode: "standard",
          scenes: specs,
          ...(aspect ? { aspect } : {}),
        });
        broadcastCreditsUpdate(user.id, res.remainingCredits);
        saveFormState(storageKey, { jobId: res.jobId });
        setJobId(res.jobId);
        setStatus("running");
        return true;
      } catch (err) {
        releaseRef.current?.();
        releaseRef.current = null;
        setError(err instanceof Error ? err.message : "候補の生成を始められませんでした。");
        setStatus("idle");
        const remaining = (err as AngleApiError)?.remainingCredits;
        if (typeof remaining === "number") broadcastCreditsUpdate(user.id, remaining);
        return false;
      }
    },
    [storageKey],
  );

  const reset = useCallback(() => {
    setJobId(null);
    setJob(null);
    setStatus("idle");
    setError(null);
    saveFormState(storageKey, { jobId: "" });
  }, [storageKey]);

  return { jobId, job, status, error, start, reset };
}

export function CandidatePanel({
  title,
  description,
  user,
  image,
  specs,
  costPerImage,
  credits,
  storageKey,
  picked,
  hasPickedFile,
  onPick,
  onLogin,
  onCharge,
  fileName,
  onPickLocal,
  existingRefs,
  confirmed,
  gpuLock,
  aspect,
  blockedReason,
  children,
}: {
  title: string;
  description: string;
  user: User | null;
  /** 候補の元にする画像（無ければボタンを押せない）。 */
  image: File | null;
  specs: CandidateSpec[];
  costPerImage: number;
  credits: number | null;
  storageKey: string;
  picked: CandidatePick | null;
  /** 選んだ画像の File を親が持っているか（リロード後は無いので、候補が読めたら取り直す）。 */
  hasPickedFile: boolean;
  onPick: (pick: CandidatePick, file: File) => void;
  onLogin: () => void;
  onCharge: () => void;
  fileName: string;
  /** 手持ちの画像で確定する（候補を作らない、2026-09-27 ホスト提案）。参照欄の画像を選ぶかファイルを選ぶ。 */
  onPickLocal?: (file: File) => void;
  existingRefs?: File[];
  /** 確定している画像（候補から選んだもの・手持ちのもののどちらも）。参照欄の何番目に入っているかも出す。 */
  confirmed?: File | null;
  /** タブ共有の鍵。他のジョブが動いていれば終わるまで待ってから投げる。 */
  gpuLock?: GpuLock;
  /** 候補を縦長（832×1248）で出す（顔アップ→全身、2026-09-29）。 */
  aspect?: "portrait";
  /** これがあると候補を作れない（理由を出す）。顔アップのとき体の設計が済むまで等。 */
  blockedReason?: string | null;
  /** 説明の下に出す欄（体の設計など）。 */
  children?: ReactNode;
}) {
  const { job, status, error, start, reset } = useCandidateJob(storageKey);
  const [picking, setPicking] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const cost = specs.length * costPerImage;
  const busy = status === "queued" || status === "submitting" || status === "running";
  const insufficient = Boolean(user) && credits !== null && credits < cost;

  const pick = useCallback(
    async (index: number) => {
      if (!job) return;
      setPicking(index);
      setPickError(null);
      try {
        const file = await candidateToFile(job.id, index, job.images[index], fileName);
        onPick({ jobId: job.id, index }, file);
      } catch (err) {
        setPickError(`候補の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPicking(null);
      }
    },
    [job, fileName, onPick],
  );

  // リロード後: 選んでいた候補の File を取り直す（1 回だけ）。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || hasPickedFile || !picked || !job || job.id !== picked.jobId) return;
    if (!job.images[picked.index]) return;
    restoredRef.current = true;
    // effect 本体では同期 setState しない（react-hooks/set-state-in-effect）。
    queueMicrotask(() => void pick(picked.index));
  }, [picked, hasPickedFile, job, pick]);

  const onStart = () => {
    if (!user) return onLogin();
    if (!image) return;
    if (blockedReason) return;
    if (insufficient) return onCharge();
    void start(user, image, specs, gpuLock, aspect);
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const confirmedUrl = useObjectUrl(confirmed ?? null);
  const confirmedRefIndex = confirmed && existingRefs ? existingRefs.indexOf(confirmed) : -1;
  // 拡大表示（候補 / 確定した画像）。
  const [light, setLight] = useState<{ items: LightItem[]; index: number } | null>(null);

  return (
    <div className="space-y-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-foreground">{title}</p>
        {status === "idle" || status === "error" ? (
          <button
            type="button"
            onClick={onStart}
            disabled={!image || Boolean(blockedReason)}
            title={blockedReason ?? undefined}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50 ${
              insufficient ? "bg-amber-600/80" : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90"
            }`}
          >
            <Sparkles size={11} />
            {insufficient ? `クレジットが足りません（${cost} C）` : `候補を ${specs.length} 枚作る（${cost} C）`}
          </button>
        ) : status === "done" ? (
          <button
            type="button"
            onClick={() => {
              reset();
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted hover:text-foreground"
          >
            <RefreshCw size={11} />
            作り直す（{cost} C）
          </button>
        ) : null}
      </div>
      <p className="text-[10px] leading-relaxed text-muted">{description}</p>
      {children}
      {blockedReason && (status === "idle" || status === "error") && (
        <p className="text-[10px] leading-relaxed text-amber-300">{blockedReason}</p>
      )}
      {onPickLocal && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith("image/"));
            if (f) onPickLocal(f);
          }}
          className={`flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed px-2 py-1.5 transition-colors ${
            dragOver ? "border-neon-pink/60 bg-neon-pink/10" : "border-transparent"
          }`}
        >
          <span className="text-[10px] text-muted">持っているなら（ここにドロップも可）:</span>
          {(existingRefs ?? []).map((f, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPickLocal(f)}
              title={f.name}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                confirmed === f
                  ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                  : "border-border text-muted hover:border-neon-violet/40 hover:text-foreground"
              }`}
            >
              参照 {i + 1} を使う
            </button>
          ))}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:border-neon-violet/40 hover:text-foreground"
          >
            ファイルを選ぶ
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && f.type.startsWith("image/")) onPickLocal(f);
              e.target.value = "";
            }}
          />
        </div>
      )}
      {busy && (
        <p className="flex items-center gap-1.5 text-[10px] text-muted">
          <Loader2 size={10} className="animate-spin" />
          {status === "queued"
            ? "他の生成が終わるのを待っています（終わり次第すぐ始まります・追加料金なし）"
            : status === "submitting"
              ? "画像を送っています…"
            : job?.status === "processing"
              ? `候補を作っています…（${job.completedAngles} / ${job.totalAngles} 枚）`
              : "生成準備中…GPUを起動しています（初回は1〜2分ほどかかります）"}
        </p>
      )}
      {confirmed && (
        <div className="flex items-center gap-2 rounded-md border border-neon-pink/40 bg-neon-pink/5 px-2 py-1">
          {confirmedUrl && (
            <button
              type="button"
              onClick={() => setLight({ items: [{ url: confirmedUrl, label: confirmed.name }], index: 0 })}
              className="relative h-12 w-10 shrink-0 cursor-zoom-in overflow-hidden rounded bg-black/40"
              title="拡大"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={confirmedUrl} alt="" className="h-full w-full object-contain" />
            </button>
          )}
          <p className="text-[10px] leading-relaxed text-foreground">
            <span className="font-medium text-neon-pink">確定:</span> {confirmed.name}
            {confirmedRefIndex >= 0 ? `（参照 ${confirmedRefIndex + 1} に入っています。この行で使われます）` : ""}
          </p>
        </div>
      )}
      {(error || pickError) && <p className="text-[10px] text-red-400">{error ?? pickError}</p>}
      {job && job.images.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {job.images.map((url, i) => {
            const on = picked?.jobId === job.id && picked.index === i;
            return (
              <button
                key={`${job.id}:${i}`}
                type="button"
                onClick={() => void pick(i)}
                disabled={picking !== null}
                title={on ? "この候補を使っています" : "この候補を使う"}
                className={`relative aspect-[4/5] overflow-hidden rounded-md border-2 ${on ? "border-neon-pink" : "border-transparent hover:border-border"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={job.labels[i] ?? ""} className="h-full w-full bg-black/40 object-contain" />
                {on && (
                  <span className="absolute right-1 top-1 rounded-full bg-neon-pink p-0.5 text-white">
                    <Check size={11} />
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={0}
                  title="拡大"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLight({ items: job.images.map((u, k) => ({ url: u, label: job.labels[k] ?? "" })), index: i });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setLight({ items: job.images.map((u, k) => ({ url: u, label: job.labels[k] ?? "" })), index: i });
                    }
                  }}
                  className="absolute left-1 top-1 cursor-zoom-in rounded-full bg-black/60 p-1 text-white opacity-80 hover:opacity-100"
                >
                  <ZoomIn size={11} />
                </span>
                {picking === i && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white">
                    <Loader2 size={14} className="animate-spin" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {status === "done" && !picked && <p className="text-[10px] text-amber-400">気に入った 1 枚をクリックして選んでください（左上の虫眼鏡で拡大）。無ければ「作り直す」。</p>}
      {light && light.items[light.index] && (
        <AngleLightbox
          items={light.items}
          index={light.index}
          onIndexChange={(i) => setLight((l) => (l ? { ...l, index: i } : l))}
          onClose={() => setLight(null)}
          onSave={(i) => downloadBlobUrl(light.items[i].url, `${light.items[i].label || "image"}.png`)}
          onUpscale={() => undefined}
          onImageError={() => undefined}
        />
      )}
    </div>
  );
}
