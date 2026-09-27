"use client";

// 参照づくり（2026-09-27、ホスト構想「1 枚から素材一式」の段階 1・3）。
// 候補を数枚作り、ユーザーが 1 枚選ぶ。選んだ画像が以後の「基準の全身」や「後ろ姿・真横の参照」になる。
// 生成した画像を次の参照に使うのはここだけ（まとめて生成では確定した参照だけを毎回使う）。
// 候補は素材づくりと同じジョブ（angle_jobs・scene 経路・メイン 1 枚・1 枚 14C）。

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, Sparkles } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import {
  AngleJobNotFoundError,
  freshAngleImageUrl,
  pollAngleJob,
  startAngleJob,
  type AngleApiError,
  type AngleJob,
} from "@/lib/angleApi";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { broadcastCreditsUpdate } from "@/hooks/useProfileCredits";

export type CandidateSpec = { instruction: string; label: string };
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

type Status = "idle" | "submitting" | "running" | "done" | "error";
const POLL_MS = 2_000;

export async function candidateToFile(jobId: string, index: number, url: string, name: string): Promise<File> {
  const fresh = await freshAngleImageUrl(jobId, index, url);
  const res = await fetch(fresh);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "image/png" });
}

/** 候補ジョブ 1 本を回す。jobId は storageKey に保存し、リロード後も候補を出し直す。 */
function useCandidateJob(storageKey: string) {
  const [jobId, setJobId] = useState<string | null>(() => loadFormState<{ jobId: string }>(storageKey)?.jobId || null);
  const [job, setJob] = useState<AngleJob | null>(null);
  const [status, setStatus] = useState<Status>(() => (jobId ? "running" : "idle"));
  const [error, setError] = useState<string | null>(null);

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
          if (next.status === "completed") {
            setStatus("done");
            return;
          }
          if (next.status === "failed") {
            setError(next.errorMessage || "候補の生成に失敗しました。");
            setStatus("error");
            return;
          }
        } catch (err) {
          if (cancelled) return;
          if (err instanceof AngleJobNotFoundError) {
            setError("候補のジョブが見つかりませんでした。作り直してください。");
            setStatus("error");
            saveFormState(storageKey, { jobId: "" });
            return;
          }
          errorStreak += 1;
          if (errorStreak >= 8) {
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
    async (user: User, image: File, specs: CandidateSpec[]) => {
      setStatus("submitting");
      setError(null);
      setJob(null);
      try {
        const res = await startAngleJob({
          userId: user.id,
          image,
          subImages: [],
          selection: { azimuths: [], elevations: [], distances: [] },
          mode: "standard",
          scenes: specs,
        });
        broadcastCreditsUpdate(user.id, res.remainingCredits);
        saveFormState(storageKey, { jobId: res.jobId });
        setJobId(res.jobId);
        setStatus("running");
        return true;
      } catch (err) {
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
}) {
  const { job, status, error, start, reset } = useCandidateJob(storageKey);
  const [picking, setPicking] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const cost = specs.length * costPerImage;
  const busy = status === "submitting" || status === "running";
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
    if (insufficient) return onCharge();
    void start(user, image, specs);
  };
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-2 rounded-lg border border-neon-violet/30 bg-neon-violet/5 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-foreground">{title}</p>
        {status === "idle" || status === "error" ? (
          <button
            type="button"
            onClick={onStart}
            disabled={!image}
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
      {onPickLocal && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-muted">持っているなら:</span>
          {(existingRefs ?? []).map((f, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPickLocal(f)}
              title={f.name}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:border-neon-violet/40 hover:text-foreground"
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
          {status === "submitting"
            ? "画像を送っています…"
            : job?.status === "processing"
              ? `候補を作っています…（${job.completedAngles} / ${job.totalAngles} 枚）`
              : "生成準備中…GPUを起動しています（初回は1〜2分ほどかかります）"}
        </p>
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
      {status === "done" && !picked && <p className="text-[10px] text-amber-400">気に入った 1 枚をクリックして選んでください。無ければ「作り直す」。</p>}
    </div>
  );
}
