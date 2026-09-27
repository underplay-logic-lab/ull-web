"use client";

// 素材づくり（2026-09-27、ホスト構想）: 1 枚の画像（＋参照最大 3 枚）から、ポーズ・場面・構図・向きを
// 変えた画像を指定枚数つくり、選んで LoRA Studio へ送る。マルチアングルと同じワーカー・同じ課金。
// 8 枚ずつのジョブに分けて順に投げ、最初の 1 ジョブで方向を確認してから残りを作る（既定）。
// 生成した画像は次の参照に使わない（ユーザーが選んだ参照だけを毎回使う）ので、ずれが連鎖しない。
//
// CLAUDE.md §6 のチェックリスト: ジョブはリロードで消えない（RUN_KEY）／「見つからない」は専用エラー／
// VramBadge／起動待ち表示／結果 URL は使い回さない（fresh URL で取り直し）／サムネは切り抜かない。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Check, Download, ImagePlus, Loader2, Sparkles, Wand2, X } from "lucide-react";
import { MAX_SUB_REFERENCE_IMAGES } from "@/lib/angleStudio";
import {
  AngleJobNotFoundError,
  freshAngleImageUrl,
  pollAngleJob,
  startAngleJob,
  type AngleApiError,
  type AngleJob,
} from "@/lib/angleApi";
import {
  buildScenePlan,
  CHIPS_BY_AXIS,
  chunkPlan,
  DEFAULT_SCENE_SELECTION,
  SCENE_BATCH_SIZE,
  SCENE_DEFAULT_COUNT,
  SCENE_MAX_COUNT,
  sceneCreditsPerImage,
  type SceneAxis,
  type ScenePlanItem,
  type SceneSelection,
} from "@/lib/datasetBuilder";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { requestStudioHandoff, sendLoraAdditions, takeStudioBatchHandoff } from "@/lib/studioHandoff";
import { VramBadge } from "@/components/studio/VramBadge";
import {
  AngleLightbox,
  ImageDropzone,
  InsufficientCreditsModal,
  SubReferenceSlots,
  useObjectUrl,
  type LightItem,
} from "@/components/studio/MultiAngleStudioTab";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";

const FORM_ID = "dataset-builder";
const RUN_KEY = "dataset-builder-run";
const POLL_MS = 2_000;

type PersistedForm = { sel: SceneSelection; count: number; confirmFirst: boolean };
/** 進行中／完了した「1 回の指定」。File は保存できないので、リロード後は結果の表示と LoRA への送りだけできる。 */
type PersistedRun = {
  plan: ScenePlanItem[];
  /** 投げた順のジョブ id（plan を SCENE_BATCH_SIZE ずつ）。 */
  jobIds: string[];
  /** 最初の 1 ジョブで止めて確認するか。 */
  confirmFirst: boolean;
  /** 「続きを作る」を押した後 true。 */
  confirmed: boolean;
  subCount: number;
};

type Phase = "idle" | "submitting" | "running" | "paused" | "done" | "error";

const AXIS_TITLE: Record<SceneAxis, string> = {
  poses: "ポーズ",
  places: "場面",
  framings: "構図",
  views: "向き",
};

function ChipGroup({
  axis,
  selected,
  onToggle,
  onAll,
  onClear,
  custom,
  onAddCustom,
  onRemoveCustom,
}: {
  axis: SceneAxis;
  selected: string[];
  onToggle: (id: string) => void;
  onAll: () => void;
  onClear: () => void;
  /** 自分で足した項目（ポーズ・場面だけ）。日本語で書ける。 */
  custom?: string[];
  onAddCustom?: (text: string) => void;
  onRemoveCustom?: (text: string) => void;
}) {
  const set = new Set(selected);
  const [draft, setDraft] = useState("");
  const commitDraft = () => {
    const t = draft.trim();
    if (!t || !onAddCustom) return;
    onAddCustom(t);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{AXIS_TITLE[axis]}</p>
        <span className="flex gap-2 text-[10px] text-muted">
          <button type="button" onClick={onAll} className="hover:text-foreground">
            全部
          </button>
          <button type="button" onClick={onClear} className="hover:text-foreground">
            解除
          </button>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CHIPS_BY_AXIS[axis].map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onToggle(c.id)}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              set.has(c.id)
                ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                : "border-border bg-background text-muted hover:border-neon-violet/40 hover:text-foreground"
            }`}
          >
            {c.label}
          </button>
        ))}
        {custom?.map((t) => (
          <span
            key={`custom:${t}`}
            className="inline-flex items-center gap-1 rounded-full border border-neon-violet/50 bg-neon-violet/10 px-2.5 py-1 text-[11px] text-neon-violet"
          >
            {t}
            <button type="button" onClick={() => onRemoveCustom?.(t)} aria-label="削除" className="hover:text-foreground">
              ×
            </button>
          </span>
        ))}
      </div>
      {onAddCustom && (
        <div className="mt-1.5 flex gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitDraft();
              }
            }}
            placeholder={axis === "places" ? "場面を追加（日本語OK・例: 桜並木の下）" : "ポーズを追加（日本語OK・例: 傘をさして立つ）"}
            className="flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] text-foreground"
          />
          <button
            type="button"
            onClick={commitDraft}
            disabled={!draft.trim()}
            className="rounded-lg border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-40"
          >
            追加
          </button>
        </div>
      )}
    </div>
  );
}

export function DatasetBuilderTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();

  const savedForm = useMemo(() => loadFormState<PersistedForm>(FORM_ID), []);
  const [image, setImageState] = useState<File | null>(null);
  const imagePreview = useObjectUrl(image);
  const [imageError, setImageError] = useState<string | null>(null);
  const [subImages, setSubImagesState] = useState<File[]>([]);
  // ポーリングの長寿命な effect から「今の画像」を読むための ref。setter を包んで state と同時に更新する。
  const imageRef = useRef<File | null>(null);
  const subImagesRef = useRef<File[]>([]);
  const setImage = useCallback((f: File | null) => {
    imageRef.current = f;
    setImageState(f);
  }, []);
  const setSubImages = useCallback((upd: File[] | ((prev: File[]) => File[])) => {
    const next = typeof upd === "function" ? upd(subImagesRef.current) : upd;
    subImagesRef.current = next;
    setSubImagesState(next);
  }, []);
  const [subError, setSubError] = useState<string | null>(null);
  const [sel, setSel] = useState<SceneSelection>(() => ({ ...DEFAULT_SCENE_SELECTION, ...(savedForm?.sel ?? {}) }));
  const [count, setCount] = useState<number>(() => savedForm?.count ?? SCENE_DEFAULT_COUNT);
  const [confirmFirst, setConfirmFirst] = useState<boolean>(() => savedForm?.confirmFirst ?? true);
  useEffect(() => {
    saveFormState(FORM_ID, { sel, count, confirmFirst } satisfies PersistedForm);
  }, [sel, count, confirmFirst]);

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // --- 1 回の指定（run）とジョブ ---------------------------------------------
  const [run, setRun] = useState<PersistedRun | null>(() => {
    const r = loadFormState<PersistedRun>(RUN_KEY);
    return r && Array.isArray(r.plan) && Array.isArray(r.jobIds) && r.plan.length > 0
      ? {
          plan: r.plan,
          jobIds: r.jobIds,
          confirmFirst: Boolean(r.confirmFirst),
          confirmed: Boolean(r.confirmed),
          subCount: Number(r.subCount ?? 0),
        }
      : null;
  });
  const runRef = useRef<PersistedRun | null>(run);
  const commitRun = useCallback((next: PersistedRun | null) => {
    runRef.current = next;
    setRun(next);
    // 完了・失敗でも消さない（リロードで結果を出し直すため）。新しい指定で上書きされる。
    saveFormState(RUN_KEY, next ?? { plan: [], jobIds: [] });
  }, []);
  const [jobs, setJobs] = useState<Record<string, AngleJob>>({});
  const [phase, setPhase] = useState<Phase>(() => (run && run.jobIds.length > 0 ? "running" : "idle"));
  const elapsedMs = useElapsedTimer(phase === "running" || phase === "submitting");

  // LoRA Studio 等から画像を受け取る（先頭がメイン、以降が参照）。
  useEffect(() => {
    const h = takeStudioBatchHandoff("dataset");
    if (!h || h.files.length === 0) return;
    queueMicrotask(() => {
      setImage(h.files[0]);
      setSubImages(h.files.slice(1, 1 + MAX_SUB_REFERENCE_IMAGES));
      setNotice(`${h.source}を受け取りました。${h.hint ? ` ${h.hint}` : ""}`);
    });
  }, [setImage, setSubImages]);

  const handleImageSelected = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setImageError("画像ファイル（PNG / JPEG / WebP）を選んでください。");
        return;
      }
      setImageError(null);
      setImage(file);
    },
    [setImage],
  );
  const handleAddSub = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setSubError("画像ファイル（PNG / JPEG / WebP）を選んでください。");
        return;
      }
      setSubError(null);
      setSubImages((prev) => (prev.length >= MAX_SUB_REFERENCE_IMAGES ? prev : [...prev, file]));
    },
    [setSubImages],
  );

  const toggle = (axis: SceneAxis, id: string) =>
    setSel((prev) => {
      const cur = prev[axis];
      return { ...prev, [axis]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });

  const subCount = subImages.length;
  const perImage = sceneCreditsPerImage(knobs, subCount);
  const safeCount = Math.max(1, Math.min(SCENE_MAX_COUNT, Math.trunc(count || 0)));
  const totalCost = safeCount * perImage;
  const firstBatch = Math.min(SCENE_BATCH_SIZE, safeCount);
  const firstCost = firstBatch * perImage;
  const busy = phase === "submitting" || phase === "running";
  const insufficientForFirst = Boolean(user) && !creditsLoading && (credits ?? 0) < firstCost;

  // --- ジョブ投入 ----------------------------------------------------------
  const submitBatch = useCallback(
    async (r: PersistedRun, batchIndex: number, mainFile: File, subs: File[]) => {
      if (!user) return;
      const batches = chunkPlan(r.plan);
      const items = batches[batchIndex];
      if (!items) return;
      setPhase("submitting");
      setErrorMessage(null);
      try {
        const res = await startAngleJob({
          userId: user.id,
          image: mainFile,
          subImages: subs,
          selection: { azimuths: [], elevations: [], distances: [] },
          mode: "standard",
          scenes: items.map((it) => ({ instruction: it.instruction, label: it.labelJa })),
        });
        broadcastCreditsUpdate(user.id, res.remainingCredits);
        const next: PersistedRun = { ...r, jobIds: [...r.jobIds, res.jobId] };
        commitRun(next);
        setPhase("running");
      } catch (err) {
        console.error("[DatasetBuilderTab] start failed:", err);
        setErrorMessage(err instanceof Error ? err.message : "ジョブの作成に失敗しました。");
        setPhase(r.jobIds.length > 0 ? "paused" : "error");
        const remaining = (err as AngleApiError)?.remainingCredits;
        if (typeof remaining === "number") {
          broadcastCreditsUpdate(user.id, remaining);
          if (remaining < perImage) setChargeOpen(true);
        }
      }
    },
    [user, commitRun, perImage],
  );

  const handleStart = () => {
    if (!user) return setLoginOpen(true);
    if (!image) return;
    if (insufficientForFirst) return setChargeOpen(true);
    const plan = buildScenePlan(sel, safeCount);
    if (plan.length === 0) return;
    const r: PersistedRun = { plan, jobIds: [], confirmFirst, confirmed: !confirmFirst, subCount };
    setJobs({});
    commitRun(r);
    void submitBatch(r, 0, image, subImages);
  };

  const handleContinue = () => {
    const r = runRef.current;
    if (!r || !image) return;
    const next = { ...r, confirmed: true };
    commitRun(next);
    void submitBatch(next, next.jobIds.length, image, subImages);
  };

  // --- ポーリング（今動いているジョブ 1 本だけ） ---------------------------------
  const activeJobId = run && run.jobIds.length > 0 ? run.jobIds[run.jobIds.length - 1] : null;
  useEffect(() => {
    if (!activeJobId || (phase !== "running" && phase !== "paused" && phase !== "done")) return;
    const j = jobs[activeJobId];
    if (j && (j.status === "completed" || j.status === "failed")) return;
    let cancelled = false;
    let errorStreak = 0;
    (async () => {
      while (!cancelled) {
        try {
          const next = await pollAngleJob(activeJobId);
          if (cancelled) return;
          errorStreak = 0;
          setJobs((prev) => ({ ...prev, [activeJobId]: next }));
          if (next.status === "completed" || next.status === "failed") {
            const r = runRef.current;
            if (!r) return;
            const batches = chunkPlan(r.plan);
            const doneBatches = r.jobIds.length;
            if (next.status === "failed") {
              setErrorMessage(next.errorMessage || "生成に失敗しました。");
              setPhase("paused");
              return;
            }
            if (doneBatches >= batches.length) {
              setPhase("done");
              return;
            }
            if (r.confirmFirst && !r.confirmed) {
              setPhase("paused");
              return;
            }
            // 次のジョブへ（画像はメモリにあるときだけ。リロード後は続きを作れないので止める）。
            const mainFile = imageRef.current;
            if (!mainFile) {
              setPhase("paused");
              setNotice("続きを作るには、同じ画像をもう一度入れてから「続きを作る」を押してください。");
              return;
            }
            void submitBatch(r, doneBatches, mainFile, subImagesRef.current);
            return;
          }
        } catch (err) {
          if (cancelled) return;
          if (err instanceof AngleJobNotFoundError) {
            setErrorMessage("このジョブは見つかりませんでした。新しく生成してください。");
            setPhase("error");
            return;
          }
          errorStreak += 1;
          if (errorStreak >= 8) {
            setErrorMessage("進捗の取得に繰り返し失敗しました。時間をおいて再読み込みしてください。");
            setPhase("error");
            return;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
    // jobs は中で読むだけ（依存に入れると完了ごとに再起動する）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId, phase, submitBatch]);

  // リロード直後: 過去のジョブの結果を読み直す（完了済みは 1 回で済む）。
  useEffect(() => {
    if (!run) return;
    const missing = run.jobIds.filter((id) => !jobs[id] && id !== activeJobId);
    if (missing.length === 0) return;
    let alive = true;
    Promise.all(missing.map((id) => pollAngleJob(id).catch(() => null))).then((rows) => {
      if (!alive) return;
      setJobs((prev) => {
        const next = { ...prev };
        rows.forEach((j, i) => {
          if (j) next[missing[i]] = j;
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.jobIds.join(",")]);

  // --- 結果 -----------------------------------------------------------------
  type ResultItem = { key: string; jobId: string; index: number; url: string; label: string };
  const results: ResultItem[] = useMemo(() => {
    if (!run) return [];
    const out: ResultItem[] = [];
    for (const id of run.jobIds) {
      const j = jobs[id];
      if (!j) continue;
      j.images.forEach((url, i) => out.push({ key: `${id}:${i}`, jobId: id, index: i, url, label: j.labels[i] ?? "" }));
    }
    return out;
  }, [run, jobs]);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const kept = results.filter((r) => !rejected.has(r.key));
  const lightItems: LightItem[] = results.map((r) => ({ url: r.url, label: r.label }));
  const toggleRejected = (key: string) =>
    setRejected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // R2 への移動・署名切れで 404 になったら取り直す（2 回まで）。
  const refreshResultUrl = (r: ResultItem) => {
    const n = reloads[r.key] ?? 0;
    if (n >= 2) return;
    void freshAngleImageUrl(r.jobId, r.index, r.url).then((u) => {
      setJobs((prev) => {
        const j = prev[r.jobId];
        if (!j) return prev;
        const images = [...j.images];
        images[r.index] = u;
        return { ...prev, [r.jobId]: { ...j, images } };
      });
      setReloads((prev) => ({ ...prev, [r.key]: n + 1 }));
    });
  };
  // 保存・LoRA・ZIP は押した時点で URL を取り直す（CLAUDE.md §6-11）。
  const fetchFresh = async (r: ResultItem): Promise<Blob> => {
    const url = await freshAngleImageUrl(r.jobId, r.index, r.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  };
  const fileName = (r: ResultItem, n: number) => `dataset_${r.jobId.slice(0, 6)}_${String(n + 1).padStart(2, "0")}.png`;
  const triggerDownload = (blob: Blob, name: string) => {
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  };
  const saveOne = async (r: ResultItem) => {
    try {
      triggerDownload(await fetchFresh(r), fileName(r, results.indexOf(r)));
    } catch (err) {
      setErrorMessage(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const upscaleOne = async (r: ResultItem) => {
    const url = await freshAngleImageUrl(r.jobId, r.index, r.url);
    requestStudioHandoff({ kind: "image", url, filename: fileName(r, results.indexOf(r)), source: "素材づくりの結果" }, "upscale");
  };
  const downloadZip = async () => {
    if (kept.length === 0) return;
    setZipping(true);
    setErrorMessage(null);
    try {
      const zip = new JSZip();
      const blobs = await Promise.all(kept.map((r) => fetchFresh(r)));
      blobs.forEach((b, n) => zip.file(fileName(kept[n], n), b));
      triggerDownload(await zip.generateAsync({ type: "blob" }), `dataset_${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (err) {
      setErrorMessage(`ZIP の作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setZipping(false);
    }
  };

  const sendToLora = async () => {
    if (kept.length === 0) return;
    setSending(true);
    setErrorMessage(null);
    try {
      const files = await Promise.all(
        kept.map(async (c, n) => {
          const blob = await fetchFresh(c);
          return new File([blob], fileName(c, n), { type: blob.type || "image/png" });
        }),
      );
      sendLoraAdditions(files, `素材づくりで作った ${files.length} 枚`);
    } catch (err) {
      setErrorMessage(`LoRA Studio への送信に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

  const activeJob = activeJobId ? jobs[activeJobId] : null;
  const plannedTotal = run?.plan.length ?? 0;
  const producedTotal = results.length;
  const remainingCount = run ? Math.max(0, plannedTotal - chunkPlan(run.plan).slice(0, run.jobIds.length).flat().length) : 0;
  const remainingCost = remainingCount * sceneCreditsPerImage(knobs, run?.subCount ?? subCount);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* 左: 入力 */}
        <div className="space-y-4">
          <ImageDropzone
            file={image}
            previewUrl={imagePreview}
            onFileSelected={handleImageSelected}
            onClear={() => setImage(null)}
          />
          {imageError && <p className="text-[11px] text-red-400">{imageError}</p>}
          <SubReferenceSlots files={subImages} onAdd={handleAddSub} onRemove={(i) => setSubImages((p) => p.filter((_, k) => k !== i))} error={subError} />
          <p className="text-[11px] leading-relaxed text-muted/80">
            メインの画像からは分からない後ろ姿・真横・顔のアップがあれば参照に足してください。参照が多いほど 1 枚あたりの時間と料金は増えます。
          </p>
          {notice && <p className="text-[11px] text-neon-violet">{notice}</p>}
        </div>

        {/* 右: 指定 */}
        <div className="space-y-4">
          <div className="grid gap-4 rounded-xl border border-border bg-background p-4">
            {(["poses", "places", "framings", "views"] as SceneAxis[]).map((axis) => (
              <ChipGroup
                key={axis}
                axis={axis}
                selected={sel[axis]}
                onToggle={(id) => toggle(axis, id)}
                onAll={() => setSel((p) => ({ ...p, [axis]: CHIPS_BY_AXIS[axis].map((c) => c.id) }))}
                onClear={() => setSel((p) => ({ ...p, [axis]: [] }))}
                {...(axis === "poses" || axis === "places"
                  ? (() => {
                      const key = axis === "poses" ? "customPoses" : "customPlaces";
                      return {
                        custom: sel[key] ?? [],
                        onAddCustom: (t: string) =>
                          setSel((p) => ((p[key] ?? []).includes(t) ? p : { ...p, [key]: [...(p[key] ?? []), t] })),
                        onRemoveCustom: (t: string) => setSel((p) => ({ ...p, [key]: (p[key] ?? []).filter((x) => x !== t) })),
                      };
                    })()
                  : {})}
              />
            ))}
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-muted">
                服装（任意・日本語OK）
                <input
                  value={sel.outfit}
                  onChange={(e) => setSel((p) => ({ ...p, outfit: e.target.value }))}
                  placeholder="例: 赤いパーカーとジーンズ"
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
                />
              </label>
              <label className="text-[11px] text-muted">
                追加の指示（任意・日本語OK）
                <input
                  value={sel.extra}
                  onChange={(e) => setSel((p) => ({ ...p, extra: e.target.value }))}
                  placeholder="例: 笑顔でコーヒーを持っている"
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
                />
              </label>
            </div>
            <p className="text-[11px] leading-relaxed text-muted/70">
              選んだ組み合わせを順に回して枚数ぶん作ります。未選択の軸は既定（立つ・無地・全身・正面）になります。日本語の入力は送るときに英訳します。
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-muted">
                枚数
                <input
                  type="number"
                  min={1}
                  max={SCENE_MAX_COUNT}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-right text-sm text-foreground"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted">
                <input type="checkbox" checked={confirmFirst} onChange={(e) => setConfirmFirst(e.target.checked)} />
                最初の {firstBatch} 枚で一度確認してから残りを作る
              </label>
              <span className="ml-auto font-mono text-sm text-foreground">
                合計 <span className="text-neon-pink">{totalCost.toLocaleString()} C</span>
                <span className="ml-1 text-[10px] text-muted">（1 枚 {perImage}C{subCount > 0 ? `・参照 ${subCount} 枚`: ""}）</span>
              </span>
            </div>
            {confirmFirst && safeCount > SCENE_BATCH_SIZE && (
              <p className="mt-1.5 text-[10px] text-muted">
                まず {firstBatch} 枚（{firstCost.toLocaleString()} C）を作って止まります。良ければ「続きを作る」で残りを作ります。クレジットは作る分ずつ消費します。
              </p>
            )}

            {busy && activeJob && activeJob.status === "pending" && (
              <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[11px] text-muted">
                <Loader2 size={12} className="animate-spin" />
                生成準備中…GPUを起動しています（初回は1〜2分ほどかかります・{formatElapsedSeconds(elapsedMs)}s）
              </p>
            )}
            {busy && activeJob && activeJob.status === "processing" && (
              <div className="mt-3">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-neon-pink to-neon-violet transition-[width] duration-500"
                    style={{ width: `${Math.max(4, (activeJob.completedAngles / Math.max(1, activeJob.totalAngles)) * 100)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-center text-[11px] text-muted">
                  このジョブ {activeJob.completedAngles} / {activeJob.totalAngles} 枚・全体 {producedTotal} / {plannedTotal} 枚（{formatElapsedSeconds(elapsedMs)}s）
                </p>
                {activeJob.vramUsedGb != null && (
                  <div className="mt-2 flex justify-center">
                    <VramBadge gb={activeJob.vramUsedGb} />
                  </div>
                )}
              </div>
            )}
            {phase === "submitting" && !activeJob && (
              <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted">
                <Loader2 size={12} className="animate-spin" /> 画像を送っています…
              </p>
            )}

            {phase === "paused" && run && remainingCount > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={!image || (!creditsLoading && (credits ?? 0) < Math.min(SCENE_BATCH_SIZE, remainingCount) * perImage)}
                  className="flex-1 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-5 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  続きを作る（残り {remainingCount} 枚・{remainingCost.toLocaleString()} C）
                </button>
                <button
                  type="button"
                  onClick={() => setPhase("done")}
                  className="rounded-xl border border-border px-4 py-3 text-xs text-muted hover:text-foreground"
                >
                  ここで止める
                </button>
                {!image && <p className="w-full text-[10px] text-amber-400">続きを作るには、同じ画像をもう一度入れてください。</p>}
              </div>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={!image || busy}
                className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-sm font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                  insufficientForFirst ? "bg-amber-600/80 hover:opacity-90" : "bg-gradient-to-r from-neon-pink to-neon-violet hover:opacity-90 glow-pink"
                }`}
              >
                <Sparkles size={16} />
                {!user
                  ? "ログインして作る"
                  : insufficientForFirst
                    ? "クレジットが足りません（チャージ）"
                    : busy
                      ? "生成中…"
                      : confirmFirst && safeCount > SCENE_BATCH_SIZE
                        ? `まず ${firstBatch} 枚を作る（${firstCost.toLocaleString()} C・全 ${safeCount} 枚で ${totalCost.toLocaleString()} C）`
                        : `${safeCount} 枚の素材を作る（${totalCost.toLocaleString()} C）`}
              </button>
            )}
            {errorMessage && <p className="mt-2 text-[11px] text-red-400">{errorMessage}</p>}
          </div>
        </div>
      </div>

      {/* 結果 */}
      {results.length > 0 && (
        <div className="space-y-3 rounded-xl border border-border bg-background p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground">
              できた素材 {results.length} 枚{plannedTotal > results.length ? `（予定 ${plannedTotal} 枚）` : ""}
              {rejected.size > 0 && <span className="ml-1 text-muted">・外した {rejected.size} 枚</span>}
            </p>
            {/* 全部できてから（または「ここで止める」の後で）まとめて保存・LoRA へ（2026-09-27、ホスト指摘）。 */}
            {phase === "done" && (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setRejected(new Set())} className="text-[11px] text-muted hover:text-foreground">
                  全部使う
                </button>
                <button
                  type="button"
                  onClick={() => void downloadZip()}
                  disabled={zipping || kept.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface disabled:opacity-50"
                >
                  {zipping ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  {kept.length} 枚を ZIP で保存
                </button>
                <button
                  type="button"
                  onClick={sendToLora}
                  disabled={sending || kept.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {sending ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  {kept.length} 枚を LoRA Studio に追加
                </button>
              </div>
            )}
          </div>
          <p className="text-[10px] text-muted">
            クリックで拡大。右上の × で外す／戻す。外した画像は保存・LoRA の対象になりません（料金は生成した分にかかります）。
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {results.map((r, i) => {
              const off = rejected.has(r.key);
              return (
                <div
                  key={r.key}
                  className={`relative aspect-[4/5] overflow-hidden rounded-lg border-2 ${off ? "border-transparent opacity-40 grayscale" : "border-neon-pink/60"}`}
                >
                  <button type="button" onClick={() => setLightboxIndex(i)} title={r.label} className="block h-full w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${r.url}${reloads[r.key] ? `#r${reloads[r.key]}` : ""}`}
                      alt={r.label}
                      className="h-full w-full bg-black/40 object-contain"
                      onError={() => refreshResultUrl(r)}
                    />
                  </button>
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[9px] text-white">{r.label}</span>
                  <button
                    type="button"
                    onClick={() => toggleRejected(r.key)}
                    title={off ? "戻す" : "外す"}
                    className={`absolute right-1 top-1 rounded-full p-1 text-white ${off ? "bg-black/70" : "bg-neon-pink"}`}
                  >
                    {off ? <Check size={11} /> : <X size={11} />}
                  </button>
                </div>
              );
            })}
          </div>
          {phase === "done" && (
            <p className="text-[10px] text-muted">
              <ImagePlus size={10} className="mr-1 inline" />
              足りなければ、枚数を入れてもう一度作れます（前の結果は新しい指定で入れ替わります。必要な分は先に保存するか LoRA Studio へ送ってください）。
            </p>
          )}
        </div>
      )}

      {lightboxIndex != null && results[lightboxIndex] && (
        <AngleLightbox
          items={lightItems}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onSave={(i) => void saveOne(results[i])}
          onUpscale={(i) => void upscaleOne(results[i])}
          onImageError={() => {
            const r = results[lightboxIndex];
            if (r) refreshResultUrl(r);
          }}
        />
      )}

      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} message="素材づくりを使うにはログインしてください。" />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={firstCost} />
    </div>
  );
}
