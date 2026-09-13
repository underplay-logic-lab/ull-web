"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Copy,
  Download,
  ImagePlus,
  LogIn,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import {
  DIRECTOR_CAMERA_MOVES,
  DIRECTOR_MAX_SCENE_DURATION_S,
  DIRECTOR_MAX_SCENES,
  DIRECTOR_MAX_TOTAL_SECONDS,
  DIRECTOR_MIN_SCENE_DURATION_S,
  DIRECTOR_MIN_SCENES,
  DIRECTOR_SCENE_TEXT_MAX_LENGTH,
  DIRECTOR_SECONDS_PER_SCENE,
  directorCostBreakdown,
  directorCostBreakdownForDuration,
  directorTotalDurationS,
  type DirectorCameraMoveId,
  type DirectorQualityMode,
  type DirectorScene,
} from "@/lib/directorPricing";
import { CINEMATIC_MODE_BY_ID } from "@/lib/cinematicPricing";
import { pollDirectorJob, startDirectorJob, type DirectorApiError, type DirectorJobStatus } from "@/lib/directorApi";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";

type Phase = "idle" | "submitting" | "running" | "done" | "error";

const JOB_KEY = "director-active-job";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function newScene(): DirectorScene {
  return { camera: "push_in", text: "", durationS: DIRECTOR_SECONDS_PER_SCENE };
}

function useObjectUrl(file: File | null): string | null {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

function ImageDropzone({
  file,
  previewUrl,
  onFileSelected,
  onClear,
}: {
  file: File | null;
  previewUrl: string | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (picked && picked.type.startsWith("image/")) onFileSelected(picked);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {file && previewUrl ? (
        <div className="relative overflow-hidden rounded-xl border border-border bg-background">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="参照画像" className="mx-auto max-h-72 w-auto object-contain" />
          <button
            type="button"
            onClick={onClear}
            className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
            aria-label="画像を外す"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
            isDragging
              ? "border-neon-pink/60 bg-neon-pink/5"
              : "border-border bg-background hover:border-neon-violet/40"
          }`}
        >
          <ImagePlus size={28} className="text-muted" />
          <span className="text-sm font-medium text-foreground">起点となる参照画像をドロップ / 選択</span>
          <span className="text-[11px] text-muted">この画像から動画が始まります（キャラ・服装・背景を維持）</span>
        </button>
      )}
    </div>
  );
}

function InsufficientCreditsModal({
  open,
  onClose,
  credits,
  cost,
}: {
  open: boolean;
  onClose: () => void;
  credits: number | null;
  cost: number;
}) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="w-full max-w-sm rounded-2xl border-gradient bg-surface p-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">クレジットが不足しています</h3>
          <button type="button" onClick={onClose} aria-label="閉じる" className="text-muted transition-colors hover:text-foreground">
            <X size={20} />
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          この処理には {cost} クレジット必要です。現在の保有クレジット: {credits ?? 0}
        </p>
        <a
          href="#pricing"
          onClick={onClose}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
        >
          <Zap size={16} />
          クレジットをチャージする
        </a>
      </div>
    </div>,
    document.body,
  );
}

type PersistedJob = { jobId: string };
type UiMode = "scenes" | "prompt";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (err) {
          console.error("[DirectorStudioTab] clipboard copy failed:", err);
        }
      }}
      className="flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
    >
      {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
      {copied ? "コピーしました" : label}
    </button>
  );
}

export function DirectorStudioTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();

  const [image, setImage] = useState<File | null>(null);
  const imagePreview = useObjectUrl(image);
  const [scenes, setScenes] = useState<DirectorScene[]>([newScene()]);

  // 画質モード（2026-09-14、VDN-H3導入）。fast=8step蒸留・無音・低コスト、
  // quality=50step非蒸留・音声あり。詳細は cinematicPricing.ts の
  // CINEMATIC_MODE_BY_ID.vdnFast / .vdnQuality 参照。
  const [qualityMode, setQualityMode] = useState<DirectorQualityMode>("fast");

  // プロンプトモード（結果画面でコピペしたプロンプトを微修正して直接
  // 再生成する経路、2026-09-14）。uiMode="prompt" の間はシーンビルダーの
  // 代わりにテキストエリア＋尺セレクタを表示し、handleRun はこちらの値を送る。
  const [uiMode, setUiMode] = useState<UiMode>("scenes");
  const [promptDraft, setPromptDraft] = useState("");
  const [promptDraftDurationS, setPromptDraftDurationS] = useState(DIRECTOR_SECONDS_PER_SCENE);

  const resumedJobId = useMemo(() => loadFormState<PersistedJob>(JOB_KEY)?.jobId || null, []);
  const [phase, setPhase] = useState<Phase>(resumedJobId ? "running" : "idle");
  const [jobId, setJobId] = useState<string | null>(resumedJobId);
  const [job, setJob] = useState<DirectorJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);

  const elapsedMs = useElapsedTimer(phase === "running");

  const sceneBreakdown = useMemo(
    () => directorCostBreakdown({ scenes, mode: qualityMode, knobs }),
    [scenes, qualityMode, knobs],
  );
  const promptBreakdown = useMemo(
    () => directorCostBreakdownForDuration({ totalDurationS: promptDraftDurationS, mode: qualityMode, knobs }),
    [promptDraftDurationS, qualityMode, knobs],
  );
  const breakdown = uiMode === "prompt" ? promptBreakdown : sceneBreakdown;
  const cost = breakdown.credits;
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < cost;
  const busy = phase === "submitting" || phase === "running";

  const canAddScene =
    scenes.length < DIRECTOR_MAX_SCENES &&
    directorTotalDurationS(scenes) + DIRECTOR_MIN_SCENE_DURATION_S <= DIRECTOR_MAX_TOTAL_SECONDS;
  const addScene = useCallback(() => {
    setScenes((prev) =>
      prev.length >= DIRECTOR_MAX_SCENES ||
      directorTotalDurationS(prev) + DIRECTOR_MIN_SCENE_DURATION_S > DIRECTOR_MAX_TOTAL_SECONDS
        ? prev
        : [...prev, newScene()],
    );
  }, []);
  const removeScene = useCallback((index: number) => {
    setScenes((prev) => (prev.length <= DIRECTOR_MIN_SCENES ? prev : prev.filter((_, i) => i !== index)));
  }, []);
  const updateScene = useCallback((index: number, patch: Partial<DirectorScene>) => {
    setScenes((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }, []);

  // 完了したジョブの合成済みプロンプトを引き継いで編集モードへ入る。
  const enterPromptMode = useCallback(() => {
    if (!job?.combinedPrompt) return;
    setPromptDraft(job.combinedPrompt);
    setPromptDraftDurationS(job.totalDurationS ?? DIRECTOR_SECONDS_PER_SCENE);
    setUiMode("prompt");
  }, [job]);
  const exitPromptMode = useCallback(() => setUiMode("scenes"), []);

  const canRun =
    Boolean(image) &&
    !busy &&
    cost > 0 &&
    (uiMode === "prompt" ? promptDraft.trim().length > 0 : scenes.every((s) => s.text.trim().length > 0));

  const handleRun = useCallback(async () => {
    if (!user) return setLoginOpen(true);
    if (!image) return;
    if (insufficientCredits) return setChargeOpen(true);

    setPhase("submitting");
    setErrorMessage(null);
    setJob(null);

    try {
      const res =
        uiMode === "prompt"
          ? await startDirectorJob({
              userId: user.id,
              image,
              rawPrompt: promptDraft.trim(),
              rawDurationS: promptDraftDurationS,
              quality: qualityMode,
            })
          : await startDirectorJob({ userId: user.id, image, scenes, quality: qualityMode });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      setJobId(res.jobId);
      setPhase("running");
    } catch (err) {
      const e = err as DirectorApiError;
      console.error("[DirectorStudioTab] start failed:", e);
      const remaining = e.remainingCredits;
      if (typeof remaining === "number") broadcastCreditsUpdate(user.id, remaining);
      setPhase("error");
      setErrorMessage(e.message || "ジョブの作成に失敗しました。");
      if (e.message?.includes("クレジット")) setChargeOpen(true);
    }
  }, [user, image, scenes, insufficientCredits, uiMode, promptDraft, promptDraftDurationS, qualityMode]);

  // --- ポーリングループ（画像/動画タブと同じ規約: 完了後も job key をクリアしない） --
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let errorStreak = 0;
    saveFormState(JOB_KEY, { jobId });

    (async () => {
      while (!cancelled) {
        try {
          const next = await pollDirectorJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);

          if (next.status === "completed") {
            setPhase("done");
            return;
          }
          if (next.status === "failed") {
            setPhase("error");
            setErrorMessage(next.errorMessage || "生成に失敗しました。");
            return;
          }
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          errorStreak += 1;
          console.warn("[DirectorStudioTab] poll error:", err);
          if (errorStreak >= POLL_MAX_CONSECUTIVE_ERRORS) {
            setPhase("error");
            setErrorMessage("状況の取得に繰り返し失敗しました。時間をおいて再読み込みしてください。");
            return;
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const totalDurationS = uiMode === "prompt" ? promptBreakdown.totalDurationS : directorTotalDurationS(scenes);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />

      {/* ── 左: 入力（参照画像 + タイムライン） ─────────────────────── */}
      <div className="flex flex-col gap-5 rounded-2xl border-gradient bg-surface/40 p-5">
        <ImageDropzone
          file={image}
          previewUrl={imagePreview}
          onFileSelected={setImage}
          onClear={() => setImage(null)}
        />

        {uiMode === "prompt" ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted">
                <Pencil size={12} />
                プロンプトモード（直接編集）
              </p>
              <button
                type="button"
                onClick={exitPromptMode}
                className="flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-foreground"
              >
                <Undo2 size={12} />
                シーンモードに戻る
              </button>
            </div>
            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={8}
              placeholder="英語・日本語どちらでも入力できます（日本語は送信時に自動で英訳されます）"
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground placeholder:text-muted"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="text-xs text-muted">尺</label>
              <select
                value={promptDraftDurationS}
                onChange={(e) => setPromptDraftDurationS(Number(e.target.value))}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
              >
                {Array.from(
                  { length: Math.floor(DIRECTOR_MAX_TOTAL_SECONDS / DIRECTOR_SECONDS_PER_SCENE) },
                  (_, i) => (i + 1) * DIRECTOR_SECONDS_PER_SCENE,
                ).map((s) => (
                  <option key={s} value={s}>
                    約{s}秒
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
              <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
              このプロンプトはそのままモデルに渡されます（シーンの自動合成はスキップされますが、日本語で書いた場合は送信前に自動で英訳されます）。
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted">
                <Clapperboard size={12} />
                タイムライン（シーン）
              </p>
              <span className="text-[11px] text-muted">合計 約{totalDurationS}秒</span>
            </div>

            <div className="flex flex-col gap-3">
              {scenes.map((scene, i) => (
                <div key={i} className="rounded-xl border border-border bg-background p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-muted">シーン {i + 1}</span>
                    {scenes.length > DIRECTOR_MIN_SCENES && (
                      <button
                        type="button"
                        onClick={() => removeScene(i)}
                        className="text-muted transition-colors hover:text-red-400"
                        aria-label={`シーン${i + 1}を削除`}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <select
                      value={scene.camera}
                      onChange={(e) => updateScene(i, { camera: e.target.value as DirectorCameraMoveId })}
                      className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
                    >
                      {DIRECTOR_CAMERA_MOVES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={scene.durationS}
                      onChange={(e) => updateScene(i, { durationS: Number(e.target.value) })}
                      className="w-24 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground"
                      aria-label={`シーン${i + 1}の秒数`}
                    >
                      {Array.from(
                        { length: DIRECTOR_MAX_SCENE_DURATION_S - DIRECTOR_MIN_SCENE_DURATION_S + 1 },
                        (_, j) => DIRECTOR_MIN_SCENE_DURATION_S + j,
                      ).map((s) => (
                        <option key={s} value={s}>
                          {s}秒
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    type="text"
                    value={scene.text}
                    onChange={(e) => updateScene(i, { text: e.target.value.slice(0, DIRECTOR_SCENE_TEXT_MAX_LENGTH) })}
                    placeholder="例: 振り返って微笑む"
                    className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted"
                  />
                </div>
              ))}
            </div>

            {canAddScene && (
              <button
                type="button"
                onClick={addScene}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-sm text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
              >
                <Plus size={14} />
                シーンを追加（最大{DIRECTOR_MAX_SCENES}・合計{DIRECTOR_MAX_TOTAL_SECONDS}秒まで）
              </button>
            )}

            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
              <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
              各シーンのカメラワーク・アイデア・秒数はAIが1本の連続した映像指示に自動合成します（時間配分はヒントであり厳密な保証ではありません）。合計最大{DIRECTOR_MAX_TOTAL_SECONDS}秒。
            </p>
          </div>
        )}
      </div>

      {/* ── 右: アクション / 結果 ───────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-background p-4">
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">画質モード</p>
          <div className="grid grid-cols-2 gap-2">
            {(["fast", "quality"] as const).map((m) => {
              const modeInfo = CINEMATIC_MODE_BY_ID[m === "quality" ? "vdnQuality" : "vdnFast"];
              const selected = qualityMode === m;
              return (
                <button
                  key={m}
                  type="button"
                  disabled={busy}
                  onClick={() => setQualityMode(m)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? "border-neon-violet/60 bg-neon-violet/10"
                      : "border-border bg-surface hover:border-neon-violet/30"
                  }`}
                >
                  <span className="block text-sm font-semibold text-foreground">{modeInfo.label}</span>
                  <span className="block text-[11px] text-muted">{modeInfo.tagline}</span>
                  {!modeInfo.hasAudio && (
                    <span className="mt-1 inline-block rounded bg-background px-1.5 py-0.5 text-[10px] text-muted">
                      無音
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-background p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Clapperboard size={14} />
              Cinematic Director
            </span>
            <span className="font-mono font-medium text-foreground">
              {cost > 0 ? (
                <span className="text-neon-pink">{cost} Credits</span>
              ) : (
                <span className="text-muted">画像とシーンを入力</span>
              )}
            </span>
          </div>

          {!user ? (
            <button
              type="button"
              onClick={() => setLoginOpen(true)}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
            >
              <LogIn size={16} />
              ログインして生成
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRun}
              disabled={!canRun}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {phase === "submitting"
                ? "送信中..."
                : phase === "running"
                  ? job?.status === "processing"
                    ? `生成中... ${formatElapsedSeconds(elapsedMs)}`
                    : "生成準備中（GPU起動中）..."
                  : "生成する"}
            </button>
          )}
          {!user && (
            <p className="mt-2 text-center text-[11px] text-muted">初回登録で10クレジットが付与されます。</p>
          )}
        </div>

        {phase === "running" && job?.queue && job.queue.queuePosition > 0 && (
          <p className="text-center text-[11px] text-muted">
            順番待ち: 残り{job.queue.queuePosition}件（推定 約{Math.round(job.queue.estimatedWaitSeconds / 60)}分）
          </p>
        )}
        {phase === "running" && (
          <div className="flex justify-center">
            <VramBadge gb={job?.vramUsedGb ?? null} />
          </div>
        )}

        {phase === "error" && errorMessage && (
          <p className="flex items-start gap-1.5 rounded-xl border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-[12px] leading-relaxed text-red-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {errorMessage}
          </p>
        )}

        {phase === "done" && job?.videoUrl && (
          <div className="rounded-xl border border-border bg-background p-3">
            <video src={job.videoUrl} controls className="w-full rounded-lg" />
            <a
              href={job.videoUrl}
              download="ull_cinematic_director.mp4"
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-neon-violet/40"
            >
              <Download size={14} />
              ダウンロード
            </a>
            {job.vramUsedGb != null && (
              <div className="mt-2 flex justify-center">
                <VramBadge gb={job.vramUsedGb} />
              </div>
            )}

            {job.combinedPrompt && (
              <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-mono uppercase tracking-widest text-muted">
                      生成に使われたプロンプト（英語）
                    </span>
                    <CopyButton text={job.combinedPrompt} label="コピー" />
                  </div>
                  <p className="max-h-32 overflow-y-auto rounded-lg border border-border bg-surface p-2.5 text-[12px] leading-relaxed text-muted">
                    {job.combinedPrompt}
                  </p>
                </div>

                {job.combinedPromptJa && (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-mono uppercase tracking-widest text-muted">日本語訳</span>
                      <CopyButton text={job.combinedPromptJa} label="コピー" />
                    </div>
                    <p className="max-h-32 overflow-y-auto rounded-lg border border-border bg-surface p-2.5 text-[12px] leading-relaxed text-muted">
                      {job.combinedPromptJa}
                    </p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={enterPromptMode}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-neon-violet/40"
                >
                  <Pencil size={14} />
                  このプロンプトを編集して再生成
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
