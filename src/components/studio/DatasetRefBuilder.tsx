"use client";

// 参照づくり（2026-09-27、ホスト構想「1 枚から素材一式」の段階 1・3）。
// 候補を数枚作り、ユーザーが 1 枚選ぶ。選んだ画像が以後の「基準の全身」や「後ろ姿・真横の参照」になる。
// 生成した画像を次の参照に使うのはここだけ（まとめて生成では確定した参照だけを毎回使う）。
// 候補は素材づくりと同じジョブ（angle_jobs・scene 経路・メイン 1 枚・1 枚 14C）。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, GitBranch, Loader2, RefreshCw, Sparkles, ZoomIn } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import {
  AngleJobNotFoundError,
  fetchAngleImageBlob,
  freshAngleImageUrl,
  pollAngleJob,
  startAngleJob,
  type AngleApiError,
  type AngleJob,
} from "@/lib/angleApi";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { AngleLightbox, useObjectUrl, type LightItem } from "@/components/studio/MultiAngleStudioTab";
import { broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { requestStudioHandoff } from "@/lib/studioHandoff";

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
/** 前の候補を何回分残すか。 */
const HISTORY_MAX = 6;

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

// 真横 → 後ろ姿の順（2026-09-29 ホスト判断）。真横は正面の髪型をそのまま保つ指示に固定する。後ろ髪を相対で
// 振る案（少し長め・短め等）は、髪を描き直すついでに顔まで別人になった（ホスト実走＋B300 比較: 前髪・お団子が
// 付くなど髪型ごと変わる）。角度 LoRA（<sks> right side view）とも比べたが、顔の近さはこの文章の指示が同等以上
// だった（ホスト目視 2/2 vs 1/4）。後ろ髪の正解を知っているときだけ hairNote で足す。
// 後ろ姿は確定した真横をサブ参照に添えて、髪の長さ・形を真横に揃える。
const SIDE_INSTRUCTION = `A full body shot in profile view from the side, standing upright, against a plain white background. The hairstyle and the outfit must be consistent with the reference. ${IDENTITY}`;

export function sideViewSpecs(hairNote: string): CandidateSpec[] {
  const note = hairNote.trim();
  return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
    instruction: note ? `${SIDE_INSTRUCTION} The hair at the back: ${note}.` : SIDE_INSTRUCTION,
    label: `真横の候補 ${i + 1}${note ? "（後ろ髪の指定どおり）" : ""}`,
  }));
}

/** 後ろ姿。withSide＝確定した真横を 2 枚目の参照に添える（髪を真横に揃える）。 */
export function backViewSpecs(hairNote: string, withSide: boolean): CandidateSpec[] {
  const base = `A full body shot seen directly from behind (back view), standing upright, against a plain white background. The hairstyle and the outfit must be consistent with the reference. ${IDENTITY}`;
  const note = hairNote.trim();
  const side = withSide ? " The length and shape of the hair at the back must match image 2 (the side view of the same character)." : "";
  return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
    instruction: `${base}${side}${note ? ` The hair at the back: ${note}.` : ""}`,
    label: `後ろ姿の候補 ${i + 1}${withSide ? "（真横に揃える）" : note ? "（後ろ髪の指定どおり）" : ""}`,
  }));
}

type Status = "idle" | "queued" | "submitting" | "running" | "done" | "error";
const POLL_MS = 2_000;

export async function candidateToFile(jobId: string, index: number, url: string, name: string): Promise<File> {
  const blob = await fetchAngleImageBlob(jobId, index, url);
  return new File([blob], name, { type: blob.type || "image/png" });
}

// 保存（2026-09-29 修正）: 別オリジン（保管先）の URL に download を付けても無視され、別タブで開くだけだった。
// 画像を取得して blob の URL にしてから保存する（CLAUDE.md §6-11: 押した時点で URL を取り直す）。
function downloadBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(u), 10_000);
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
    async (user: User, image: File, specs: CandidateSpec[], lock?: GpuLock, aspect?: "portrait", subImages: File[] = []) => {
      setStatus("queued");
      setError(null);
      setJob(null);
      if (lock) releaseRef.current = await lock.acquire();
      setStatus("submitting");
      try {
        const res = await startAngleJob({
          userId: user.id,
          image,
          subImages,
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
  subImages,
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
  /** 候補づくりに毎回添える参照（後ろ姿に確定した真横、2026-09-29）。料金は親が参照込みの単価で渡す。 */
  subImages?: File[];
}) {
  const { job, status, error, start, reset } = useCandidateJob(storageKey);
  // 選び中の候補（"jobId:index"）と、派生の元を取りに行っている候補。
  const [picking, setPicking] = useState<string | null>(null);
  const [deriving, setDeriving] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  // 完了直後の URL は Volume を指していて、R2 へ移ると 404 になる（R2 の署名も 15 分で切れる）。表示が切れたら
  // 取り直す（2 回まで、CLAUDE.md §6-11）。候補ジョブの URL はポーリング終了後は更新されないので、ここで上書きする。
  const [freshUrls, setFreshUrls] = useState<Record<string, string>>({});
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const urlOf = (j: AngleJob, i: number) => freshUrls[`${j.id}:${i}`] ?? j.images[i];
  const refreshUrl = (j: AngleJob, i: number, onFresh?: (u: string) => void) => {
    const key = `${j.id}:${i}`;
    const n = reloads[key] ?? 0;
    if (n >= 2) return;
    setReloads((p) => ({ ...p, [key]: n + 1 }));
    void freshAngleImageUrl(j.id, i, j.images[i]).then((u) => {
      setFreshUrls((p) => ({ ...p, [key]: u }));
      onFresh?.(u);
    });
  };
  const cost = specs.length * costPerImage;
  const busy = status === "queued" || status === "submitting" || status === "running";
  // 進行中の経過秒（表示用）。
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    queueMicrotask(() => setElapsed(0));
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [busy]);
  const insufficient = Boolean(user) && credits !== null && credits < cost;

  // 前の候補（2026-09-29、ホスト要望「作り直しても前の候補から選べるように」）。作り直すたびに今の候補をここへ移す。
  // ジョブ id だけ保存し、リロード後は一度だけ読み直す。
  const histKey = `${storageKey}-hist`;
  const [history, setHistory] = useState<AngleJob[]>([]);
  useEffect(() => {
    const ids = loadFormState<{ ids: string[] }>(histKey)?.ids ?? [];
    if (ids.length === 0) return;
    let alive = true;
    void Promise.all(ids.map((id) => pollAngleJob(id).catch(() => null))).then((jobs) => {
      if (alive) setHistory(jobs.filter((j): j is AngleJob => Boolean(j && j.status === "completed" && j.images.length > 0)));
    });
    return () => {
      alive = false;
    };
  }, [histKey]);
  const pushHistory = (j: AngleJob | null) => {
    if (!j || j.status !== "completed" || j.images.length === 0) return;
    const next = [j, ...history.filter((x) => x.id !== j.id)].slice(0, HISTORY_MAX);
    setHistory(next);
    saveFormState(histKey, { ids: next.map((x) => x.id) });
  };

  const pick = useCallback(
    async (j: AngleJob, index: number) => {
      setPicking(`${j.id}:${index}`);
      setPickError(null);
      try {
        const file = await candidateToFile(j.id, index, j.images[index], fileName);
        onPick({ jobId: j.id, index }, file);
      } catch (err) {
        setPickError(`候補の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setPicking(null);
      }
    },
    [fileName, onPick],
  );

  // リロード後: 選んでいた候補の File を取り直す（1 回だけ）。今の候補か前の候補のどちらかにある。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || hasPickedFile || !picked) return;
    const src = [job, ...history].find((j) => j && j.id === picked.jobId);
    if (!src || !src.images[picked.index]) return;
    restoredRef.current = true;
    // effect 本体では同期 setState しない（react-hooks/set-state-in-effect）。
    queueMicrotask(() => void pick(src, picked.index));
  }, [picked, hasPickedFile, job, history, pick]);

  /**
   * 作り直す（ボタン 1 回で次の候補を作り始める）。base を渡すと、その候補をメイン画像にして同じ指示で作る
   * ＝気に入った候補に近いバリエーション（2026-09-29 ホスト案「一番良いのを元に追加で作れると当たりやすい」）。
   * 今の候補は「前の候補」へ移して、あとからも選べるようにする。
   */
  const regenerate = async (base?: { job: AngleJob; index: number }) => {
    if (!user) return onLogin();
    if (!image || busy) return;
    if (insufficient) return onCharge();
    let src: File = image;
    if (base) {
      const key = `${base.job.id}:${base.index}`;
      setDeriving(key);
      setPickError(null);
      try {
        src = await candidateToFile(base.job.id, base.index, urlOf(base.job, base.index), `candidate_base_${base.index + 1}.png`);
      } catch (err) {
        setPickError(`元にする候補の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
        return;
      } finally {
        setDeriving(null);
      }
    }
    pushHistory(job);
    reset();
    void start(user, src, specs, gpuLock, aspect, subImages);
  };

  const onStart = () => {
    if (!user) return onLogin();
    if (!image) return;
    if (blockedReason) return;
    if (insufficient) return onCharge();
    void start(user, image, specs, gpuLock, aspect, subImages);
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const confirmedUrl = useObjectUrl(confirmed ?? null);
  const confirmedRefIndex = confirmed && existingRefs ? existingRefs.indexOf(confirmed) : -1;
  // 拡大表示（候補 / 確定した画像）。候補のときは jobId を持ち、切れた URL を取り直す。
  const [light, setLight] = useState<{ items: LightItem[]; index: number; job?: AngleJob } | null>(null);
  const saveLight = async (i: number) => {
    if (!light) return;
    const item = light.items[i];
    const name = `${(item.label || "image").replace(/[\\/:*?"<>|]/g, "_")}.png`;
    try {
      const blob = light.job
        ? await fetchAngleImageBlob(light.job.id, i, urlOf(light.job, i))
        : await (await fetch(item.url)).blob();
      downloadBlob(blob, name);
    } catch (err) {
      setPickError(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // 超解像へ（候補のときだけ。押した時点で URL を取り直して渡す、CLAUDE.md §6-11）。
  const upscaleLight = async (i: number) => {
    const j = light?.job;
    if (!j) return;
    try {
      const url = await freshAngleImageUrl(j.id, i, urlOf(j, i));
      requestStudioHandoff({ kind: "image", url, filename: `candidate_${i + 1}.png`, source: "参照づくりの候補" }, "upscale");
    } catch (err) {
      setPickError(`超解像への受け渡しに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const openLight = (j: AngleJob, i: number) =>
    setLight({ items: j.images.map((_, k) => ({ url: urlOf(j, k), label: j.labels[k] ?? "" })), index: i, job: j });

  const renderGrid = (j: AngleJob) => (
    <div className="grid grid-cols-4 gap-1.5">
      {j.images.map((_, i) => {
        const key = `${j.id}:${i}`;
        const on = picked?.jobId === j.id && picked.index === i;
        return (
          <div key={key} className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => void pick(j, i)}
              disabled={picking !== null}
              title={on ? "この候補を使っています" : "この候補を使う"}
              className={`relative aspect-[4/5] overflow-hidden rounded-md border-2 ${on ? "border-neon-pink" : "border-transparent hover:border-border"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={urlOf(j, i)}
                alt={j.labels[i] ?? ""}
                className="h-full w-full bg-black/40 object-contain"
                onError={() => refreshUrl(j, i)}
              />
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
                  openLight(j, i);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    openLight(j, i);
                  }
                }}
                className="absolute left-1 top-1 cursor-zoom-in rounded-full bg-black/60 p-1 text-white opacity-80 hover:opacity-100"
              >
                <ZoomIn size={11} />
              </span>
              {(picking === key || deriving === key) && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white">
                  <Loader2 size={14} className="animate-spin" />
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void regenerate({ job: j, index: i })}
              disabled={busy || deriving !== null || !image}
              title={`この候補をメイン画像にして、似た候補を ${specs.length} 枚作ります（${cost} C）`}
              className="inline-flex items-center justify-center gap-0.5 rounded border border-border px-1 py-0.5 text-[10px] text-muted hover:border-neon-violet/40 hover:text-foreground disabled:opacity-40"
            >
              <GitBranch size={10} />
              これを元に
            </button>
          </div>
        );
      })}
    </div>
  );

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
            onClick={() => void regenerate()}
            disabled={deriving !== null}
            title="元の画像からもう一度候補を作ります。今の候補は下の「前の候補」に残ります"
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-40"
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
        // 候補づくりの進行中表示（2026-09-29 ホスト指摘「作っているのが目立たなすぎる」）。枠・進捗バー・枚数ぶんの
        // 仮の枠で、作っている最中だと一目で分かるようにする。できた候補は仮の枠に順に入る。
        <div className="space-y-2 rounded-lg border border-neon-pink/50 bg-neon-pink/10 px-3 py-2.5">
          <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Loader2 size={16} className="animate-spin text-neon-pink" />
            {status === "queued"
              ? "順番待ち中：他の生成が終わり次第すぐ始まります（追加料金なし）"
              : status === "submitting"
                ? "画像を送っています…"
                : job?.status === "processing"
                  ? `候補を作っています…（${job.completedAngles} / ${job.totalAngles} 枚）`
                  : "生成準備中…GPUを起動しています（初回は1〜2分ほどかかります）"}
            <span className="ml-auto font-mono text-[11px] font-normal text-muted">{elapsed}秒</span>
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
            <div
              className={`h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-all duration-500 ${
                job?.status === "processing" ? "" : "w-1/3 animate-pulse"
              }`}
              style={job?.status === "processing" && job.totalAngles > 0 ? { width: `${Math.max(4, (job.completedAngles / job.totalAngles) * 100)}%` } : undefined}
            />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {specs.map((sp, i) => {
              const url = job?.images[i];
              return (
                <div key={i} className="relative aspect-[4/5] overflow-hidden rounded-md border border-border bg-black/30">
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt={sp.label} className="h-full w-full object-contain" />
                  ) : (
                    <div className="flex h-full w-full animate-pulse items-center justify-center bg-gradient-to-br from-neon-violet/10 to-neon-pink/10">
                      <Sparkles size={14} className="text-neon-violet/60" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
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
      {job && job.images.length > 0 && renderGrid(job)}
      {status === "done" && !picked && (
        <p className="text-[10px] text-amber-400">
          気に入った 1 枚をクリックして選んでください（左上の虫眼鏡で拡大）。惜しい候補があれば「これを元に」で似た候補を、
          無ければ「作り直す」で元の画像からもう一度作れます。
        </p>
      )}
      {history.length > 0 && (
        <div className="space-y-1.5 border-t border-border/60 pt-2">
          <p className="text-[10px] text-muted">前の候補（ここからも選べます・新しい順）</p>
          {history.map((h) => (
            <div key={h.id}>{renderGrid(h)}</div>
          ))}
        </div>
      )}
      {light && light.items[light.index] && (
        <AngleLightbox
          items={light.items}
          index={light.index}
          onIndexChange={(i) => setLight((l) => (l ? { ...l, index: i } : l))}
          onClose={() => setLight(null)}
          onSave={(i) => void saveLight(i)}
          onUpscale={light.job ? (i) => void upscaleLight(i) : undefined}
          onImageError={() => {
            // 候補の拡大表示なら、その候補の URL を取り直して拡大側も差し替える。
            const j = light.job;
            if (!j) return;
            const i = light.index;
            refreshUrl(j, i, (u) =>
              setLight((l) => (l ? { ...l, items: l.items.map((it, k) => (k === i ? { ...it, url: u } : it)) } : l)),
            );
          }}
        />
      )}
    </div>
  );
}
