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
  DIRECTOR_DIALOGUE_MAX_LENGTH,
  DIRECTOR_MAX_SCENE_DURATION_S,
  DIRECTOR_MAX_SCENES,
  DIRECTOR_MAX_TOTAL_SECONDS,
  DIRECTOR_MIN_SCENE_DURATION_S,
  DIRECTOR_MIN_SCENES,
  DIRECTOR_MUSIC_MAX_LENGTH,
  DIRECTOR_SCENE_TEXT_MAX_LENGTH,
  DIRECTOR_SECONDS_PER_SCENE,
  directorCostBreakdown,
  directorCostBreakdownForDuration,
  directorPriorityParallelSurcharge,
  directorQwenScriptSurcharge,
  directorTotalDurationS,
  type DirectorCameraMoveId,
  type DirectorQualityMode,
  type DirectorScene,
} from "@/lib/directorPricing";
import { CINEMATIC_MODE_BY_ID } from "@/lib/cinematicPricing";
import {
  pollDirectorJob,
  startDirectorJob,
  downloadDirectorVideo,
  listDirectorLoras,
  type DirectorApiError,
  type DirectorJobStatus,
  type DirectorLoraOption,
  type DirectorLoraSelection,
} from "@/lib/directorApi";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";
import { useLocalWarmCountdown } from "@/hooks/useLocalWarmCountdown";
import {
  QueueChoiceModal,
  QueuedNextBanner,
  WarmCountdownBanner,
} from "@/components/studio/QueueChoiceModal";

type Phase = "idle" | "submitting" | "running" | "done" | "error";

const JOB_KEY = "director-active-job";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function newScene(): DirectorScene {
  return { camera: "push_in", text: "", durationS: DIRECTOR_SECONDS_PER_SCENE, sceneChange: true };
}

// シーンごとの秒数セレクトに常に出す固定の選択肢（3〜30秒）。他シーンの
// 値に応じて選択肢そのものを動的に間引く実装だと、既に選ばれている値が
// 新しい上限からはみ出た瞬間、controlled <select> が一致する <option> を
// 見失って一覧の先頭（最小値）を表示してしまう不具合があった
// （2026-09-15 ホスト報告: 合計60秒に収まる組み合わせのはずが全シーン
// 3秒表示になる／一部シーンが中途半端な秒数以上選べなくなる）。選択肢は
// 常に固定にし、代わりに updateScene 側で「今操作した値」だけを即座に
// クランプすることで、表示とstateの不一致を起こさないようにする。
const DIRECTOR_SCENE_DURATION_OPTIONS = Array.from(
  { length: DIRECTOR_MAX_SCENE_DURATION_S - DIRECTOR_MIN_SCENE_DURATION_S + 1 },
  (_, j) => DIRECTOR_MIN_SCENE_DURATION_S + j,
);

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
  const [rejectError, setRejectError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (!picked) return;
    if (picked.type.startsWith("image/")) {
      setRejectError(null);
      onFileSelected(picked);
    } else {
      // 2026-09-15 ホスト報告: 動画ファイル(MP4等)を誤ってドロップしても
      // 何のフィードバックも無く無視されるだけだった（「読み込まない」と
      // 誤解される原因）。起点画像は静止画のみ対応 — 動画入力の機能は無い
      // ことを明示する。
      setRejectError(
        picked.type.startsWith("video/")
          ? "動画ファイルは使えません。起点となる1枚の静止画（PNG/JPEG/WebP等）を選んでください。"
          : "画像ファイルのみ対応しています。",
      );
    }
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
      {rejectError && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-red-400">
          <AlertTriangle size={12} className="shrink-0" />
          {rejectError}
        </p>
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
// "advanced": Qwen3.8-27B-abliterated（自己ホストVLM）に参照画像＋短い日本語
// の思いつきを渡し、台本を自動で書き起こしてもらうモード（2026-09-18追加）。
// "prompt" と違い、結果画面からの遷移ではなくユーザーが最初から選ぶ。
type UiMode = "scenes" | "prompt" | "advanced";

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

  // 画質モード（2026-09-14、VDN-H3導入）。fast=8step蒸留・低コスト、
  // quality=50step非蒸留・高品質。両方とも音声あり（2026-09-18、fastの
  // 「音声非対応」は誤診断と判明——cinematicPricing.ts参照）。詳細は
  // CINEMATIC_MODE_BY_ID.vdnFast / .vdnQuality 参照。
  const [qualityMode, setQualityMode] = useState<DirectorQualityMode>("fast");

  // 動画全体の音楽・環境音の指示（任意・シーンビルダー限定、2026-09-15追加）。
  const [musicDirection, setMusicDirection] = useState("");

  // プロンプトモード（結果画面でコピペしたプロンプトを微修正して直接
  // 再生成する経路、2026-09-14）。uiMode="prompt" の間はシーンビルダーの
  // 代わりにテキストエリア＋尺セレクタを表示し、handleRun はこちらの値を送る。
  const [uiMode, setUiMode] = useState<UiMode>("scenes");
  const [promptDraft, setPromptDraft] = useState("");
  const [promptDraftDurationS, setPromptDraftDurationS] = useState(DIRECTOR_SECONDS_PER_SCENE);

  // Advanced モード（2026-09-18追加。TODO(advanced-gate): 月額プラン限定に
  // する場合はこのモードを選べる条件をここに追加する — 今回は未実装）。
  const [conceptText, setConceptText] = useState("");
  const [conceptDurationS, setConceptDurationS] = useState(DIRECTOR_SECONDS_PER_SCENE);

  // LoRA（2026-09-18追加。全モード共通・任意）。①LoRA Studio学習済みから選ぶ
  // ②外部で用意した .safetensors をこの場でアップロード、の2系統を持つ。
  type LoraSource = "none" | "trained" | "upload";
  const [loraSource, setLoraSource] = useState<LoraSource>("none");
  const [loraOptions, setLoraOptions] = useState<DirectorLoraOption[]>([]);
  const [loraId, setLoraId] = useState("");
  const [loraUploadFile, setLoraUploadFile] = useState<File | null>(null);
  const loraSelection: DirectorLoraSelection =
    loraSource === "trained" && loraId
      ? { source: "trained", loraId }
      : loraSource === "upload" && loraUploadFile
        ? { source: "upload", file: loraUploadFile }
        : { source: "none" };
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listDirectorLoras()
      .then((loras) => {
        if (!cancelled) setLoraOptions(loras);
      })
      .catch((err) => console.warn("[DirectorStudioTab] listDirectorLoras failed:", err));
    return () => {
      cancelled = true;
    };
  }, [user]);

  const resumedJobId = useMemo(() => loadFormState<PersistedJob>(JOB_KEY)?.jobId || null, []);
  const [phase, setPhase] = useState<Phase>(resumedJobId ? "running" : "idle");
  const [jobId, setJobId] = useState<string | null>(resumedJobId);
  const [job, setJob] = useState<DirectorJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);

  const elapsedMs = useElapsedTimer(phase === "running");
  const { isWarm: gpuWarm, remainingMs: gpuWarmMs, markWarm: markGpuWarm } = useLocalWarmCountdown(30);

  const [queueChoiceOpen, setQueueChoiceOpen] = useState(false);
  type QueuedSnapshot =
    | {
        uiMode: "scenes";
        image: File;
        scenes: DirectorScene[];
        quality: DirectorQualityMode;
        musicDirection: string;
        lora: DirectorLoraSelection;
      }
    | {
        uiMode: "prompt";
        image: File;
        rawPrompt: string;
        rawDurationS: number;
        quality: DirectorQualityMode;
        lora: DirectorLoraSelection;
      }
    | {
        uiMode: "advanced";
        image: File;
        conceptText: string;
        rawDurationS: number;
        quality: DirectorQualityMode;
        lora: DirectorLoraSelection;
      };
  const [queuedNext, setQueuedNext] = useState<QueuedSnapshot | null>(null);
  // ポーリングの長寿命な useEffect から「今すぐ最新の予約」を読めるようにする
  // ref。イベントハンドラでだけ書き込み、effect 内では書き込まない
  // （CLAUDE.md §6）。
  const queuedNextRef = useRef<QueuedSnapshot | null>(null);

  const sceneBreakdown = useMemo(
    () => directorCostBreakdown({ scenes, mode: qualityMode, knobs }),
    [scenes, qualityMode, knobs],
  );
  const promptBreakdown = useMemo(
    () => directorCostBreakdownForDuration({ totalDurationS: promptDraftDurationS, mode: qualityMode, knobs }),
    [promptDraftDurationS, qualityMode, knobs],
  );
  const conceptBreakdown = useMemo(
    () => directorCostBreakdownForDuration({ totalDurationS: conceptDurationS, mode: qualityMode, knobs }),
    [conceptDurationS, qualityMode, knobs],
  );
  const breakdown = uiMode === "prompt" ? promptBreakdown : uiMode === "advanced" ? conceptBreakdown : sceneBreakdown;
  // Advanced（Qwen台本生成）は動画本体とは別のGPUコンテナを1回起動する分の
  // 追加クレジットが乗る（directorPricing.ts::directorQwenScriptSurcharge）。
  const cost = breakdown.credits + (uiMode === "advanced" ? directorQwenScriptSurcharge(knobs) : 0);
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
    setScenes((prev) => {
      const next = prev.map((s, i) => (i === index ? { ...s, ...patch } : s));
      if (patch.durationS != null) {
        // 合計60秒の上限は「今操作した値」だけをその場でクランプして守る
        // （他シーンの選択肢を動的に間引く旧実装の不具合は上記コメント参照）。
        const othersSum = next.reduce((acc, s, i) => (i === index ? acc : acc + s.durationS), 0);
        const maxForThis = Math.max(
          DIRECTOR_MIN_SCENE_DURATION_S,
          Math.min(DIRECTOR_MAX_SCENE_DURATION_S, DIRECTOR_MAX_TOTAL_SECONDS - othersSum),
        );
        next[index] = { ...next[index], durationS: Math.min(next[index].durationS, maxForThis) };
      }
      return next;
    });
  }, []);

  // 完了したジョブの合成済みプロンプトを引き継いで編集モードへ入る。
  // 日本語訳がある場合はそちらを既定で読み込む（2026-09-18、ホスト要望 —
  // 送信時に looksJapanese() で自動検知して英訳されるので、日本語のまま
  // 編集して再生成できる。日本語訳が無い場合は従来通り英語のまま）。
  const enterPromptMode = useCallback(() => {
    if (!job?.combinedPrompt) return;
    setPromptDraft(job.combinedPromptJa || job.combinedPrompt);
    setPromptDraftDurationS(job.totalDurationS ?? DIRECTOR_SECONDS_PER_SCENE);
    setUiMode("prompt");
  }, [job]);
  const exitPromptMode = useCallback(() => setUiMode("scenes"), []);

  // LoRAのソースを選んだのに中身（選択/ファイル）が空のままだと、意図せず
  // 「なし」で生成されてしまう——選んだ以上は完了させてから送信させる。
  const loraSelectionIncomplete =
    (loraSource === "trained" && !loraId) || (loraSource === "upload" && !loraUploadFile);

  const canRun =
    Boolean(image) &&
    cost > 0 &&
    !loraSelectionIncomplete &&
    (uiMode === "prompt"
      ? promptDraft.trim().length > 0
      : uiMode === "advanced"
        ? conceptText.trim().length > 0
        : scenes.every((s) => s.text.trim().length > 0));

  const buildSnapshot = (): QueuedSnapshot | null => {
    if (!image) return null;
    if (uiMode === "prompt") {
      return {
        uiMode: "prompt",
        image,
        rawPrompt: promptDraft.trim(),
        rawDurationS: promptDraftDurationS,
        quality: qualityMode,
        lora: loraSelection,
      };
    }
    if (uiMode === "advanced") {
      return {
        uiMode: "advanced",
        image,
        conceptText: conceptText.trim(),
        rawDurationS: conceptDurationS,
        quality: qualityMode,
        lora: loraSelection,
      };
    }
    return {
      uiMode: "scenes",
      image,
      scenes,
      quality: qualityMode,
      musicDirection: musicDirection.trim(),
      lora: loraSelection,
    };
  };

  const handleRun = () => {
    if (!user) return setLoginOpen(true);
    const snapshot = buildSnapshot();
    if (!snapshot) return;
    // 実行中に押した場合は「順番待ち」か「並列実行」かを選ばせる（CLAUDE.md
    // §6）。insufficientCredits より先に置くこと。
    if (busy) {
      setQueueChoiceOpen(true);
      return;
    }
    if (insufficientCredits) return setChargeOpen(true);
    void runGenerate(snapshot);
  };

  const handleQueueWait = () => {
    const snapshot = buildSnapshot();
    if (!snapshot) return;
    queuedNextRef.current = snapshot;
    setQueuedNext(snapshot);
    setQueueChoiceOpen(false);
  };

  const handleCancelQueue = () => {
    queuedNextRef.current = null;
    setQueuedNext(null);
  };

  const handleQueueParallel = () => {
    const snapshot = buildSnapshot();
    if (!snapshot) return;
    setQueueChoiceOpen(false);
    const surcharge = directorPriorityParallelSurcharge(knobs);
    if (!creditsLoading && (credits ?? 0) < cost + surcharge) {
      setChargeOpen(true);
      return;
    }
    void runGenerate(snapshot, { priority: true });
  };

  // snapshot を明示的に渡す設計: キュー待ちの「次の1件」は予約した時点の
  // image/scenes（またはprompt）を使う必要があり、発火時点の（変わっている
  // かもしれない）現在の state を読んではいけない。ポーリングの長寿命な
  // useEffect からも呼ぶため、参照が安定するよう useCallback にする。
  const runGenerate = useCallback(
    async (snapshot: QueuedSnapshot, opts: { priority?: boolean } = {}) => {
      if (!user) return;
      setPhase("submitting");
      setErrorMessage(null);
      setJob(null);

      try {
        const res =
          snapshot.uiMode === "prompt"
            ? await startDirectorJob({
                userId: user.id,
                image: snapshot.image,
                rawPrompt: snapshot.rawPrompt,
                rawDurationS: snapshot.rawDurationS,
                quality: snapshot.quality,
                priority: opts.priority,
                lora: snapshot.lora,
              })
            : snapshot.uiMode === "advanced"
              ? await startDirectorJob({
                  userId: user.id,
                  image: snapshot.image,
                  conceptText: snapshot.conceptText,
                  rawDurationS: snapshot.rawDurationS,
                  quality: snapshot.quality,
                  priority: opts.priority,
                  lora: snapshot.lora,
                })
              : await startDirectorJob({
                  userId: user.id,
                  image: snapshot.image,
                  scenes: snapshot.scenes,
                  musicDirection: snapshot.musicDirection || undefined,
                  quality: snapshot.quality,
                  priority: opts.priority,
                  lora: snapshot.lora,
                });
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
    },
    [user],
  );

  // --- ポーリングループ（画像/動画タブと同じ規約: 完了後も job key をクリアしない） --
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let errorStreak = 0;
    // 「このポーリングセッション中に実行中状態を実際に経由してから完了した」
    // 場合だけ warm 扱いにする（CLAUDE.md §6、タブ再読み込み直後の誤検知防止）。
    let sawInProgress = false;
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
            if (sawInProgress) markGpuWarm();
            const queued = queuedNextRef.current;
            if (queued) {
              // 次のジョブが即座に画面を上書きしてしまう前に、今完了した
              // 分をブラウザへ自動保存しておく（連続キュー時、ユーザーが
              // 手動ダウンロードボタンを押す間もなく次の生成中表示に
              // 切り替わってしまい、過去の結果に戻る手段が無いUI上の
              // ギャップへの対策。失敗しても致命的ではない — サーバー側
              // には director-results バケットへ既に永続化済みなので、
              // ここが失敗しても「消える」わけではない）。
              if (next.videoUrl) {
                downloadDirectorVideo(next.videoUrl, `ull_cinematic_director_${next.jobId}.mp4`).catch((err) => {
                  console.warn("[DirectorStudioTab] auto-download before next queued job failed:", err);
                });
              }
              queuedNextRef.current = null;
              setQueuedNext(null);
              void runGenerate(queued);
            }
            return;
          }
          if (next.status === "failed") {
            setPhase("error");
            setErrorMessage(next.errorMessage || "生成に失敗しました。");
            return;
          }
          sawInProgress = true;
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
  }, [jobId, markGpuWarm, runGenerate]);

  const totalDurationS =
    uiMode === "prompt"
      ? promptBreakdown.totalDurationS
      : uiMode === "advanced"
        ? conceptBreakdown.totalDurationS
        : directorTotalDurationS(scenes);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />
      <QueueChoiceModal
        open={queueChoiceOpen}
        surcharge={directorPriorityParallelSurcharge(knobs)}
        onCancel={() => setQueueChoiceOpen(false)}
        onQueue={handleQueueWait}
        onParallel={handleQueueParallel}
      />

      {/* ── 左: 入力（参照画像 + タイムライン） ─────────────────────── */}
      <div className="flex flex-col gap-5 rounded-2xl border-gradient bg-surface/40 p-5">
        <ImageDropzone
          file={image}
          previewUrl={imagePreview}
          onFileSelected={setImage}
          onClear={() => setImage(null)}
        />

        {
          // モード切替（2026-09-18追加、同日「プロンプトで作る」を追加）。
          // "prompt" は元々「結果画面の編集して再生成」経由でしか入れない
          // 特別モードだったが、Advanced（台本自動生成）はQwenが立ち上がる
          // うえ文字数制限もあり「そのまま普通の日本語プロンプトを打ちたい」
          // 用途には向かない——かつAdvanced自体は将来サブスク限定にする
          // 可能性がある（TODO(advanced-gate)）ため、その中にチェックボックス
          // で逃げ道を作るのではなく、シーンビルダーと対等な3つ目のタブとして
          // 独立させた（ホストとの相談で決定）。
          // TODO(advanced-gate): Advanced を月額プラン限定にする場合は
          // ここで契約状態を見て disabled にする／アップセル導線を出す。
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => setUiMode("scenes")}
              className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                uiMode === "scenes" ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              シーンで作る
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setUiMode("prompt")}
              className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                uiMode === "prompt" ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              <Pencil size={12} />
              プロンプトで作る
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setUiMode("advanced")}
              className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                uiMode === "advanced" ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              <Sparkles size={12} />
              Advanced（台本自動生成）
            </button>
          </div>
        }

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
              このプロンプトはそのままモデルに渡されます（シーンの自動合成はスキップされますが、日本語で書いた場合は送信前に自動で英訳されます）。セリフを話させたい部分は「」で囲むと、そこだけ日本語のまま音声・リップシンクに反映されます。
            </p>
          </div>
        ) : uiMode === "advanced" ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted">
                <Sparkles size={12} />
                Advanced（AIによる台本自動生成）
              </p>
            </div>
            <textarea
              value={conceptText}
              onChange={(e) => setConceptText(e.target.value.slice(0, DIRECTOR_SCENE_TEXT_MAX_LENGTH))}
              rows={4}
              placeholder="例: 雨が降るネオンに照らされた夜の路地裏で、静かにこちらを見つめている。"
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground placeholder:text-muted"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="text-xs text-muted">尺</label>
              <select
                value={conceptDurationS}
                onChange={(e) => setConceptDurationS(Number(e.target.value))}
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
              参照画像を実際に見た上で、短いアイデアからAIが台本を書き起こします（検閲による生成拒否が起きにくい代わりに追加でクレジットを消費します）。
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
                      {DIRECTOR_SCENE_DURATION_OPTIONS.map((s) => (
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
                  <input
                    type="text"
                    value={scene.dialogue ?? ""}
                    onChange={(e) =>
                      updateScene(i, { dialogue: e.target.value.slice(0, DIRECTOR_DIALOGUE_MAX_LENGTH) || undefined })
                    }
                    placeholder="セリフ（任意・リップシンク対応。例: こんにちは）"
                    className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted"
                  />
                  {i > 0 && (
                    <label className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        checked={scene.sceneChange !== false}
                        onChange={(e) => updateScene(i, { sceneChange: e.target.checked })}
                        className="h-3.5 w-3.5 rounded border-border"
                      />
                      ここで場面を切り替える（オフ＝前のシーンと同じ場面の続き）
                    </label>
                  )}
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

            <div className="mt-3">
              <label className="mb-1 block text-[11px] font-medium text-muted">
                音楽・環境音の指示（任意・動画全体に反映）
              </label>
              <input
                type="text"
                value={musicDirection}
                onChange={(e) => setMusicDirection(e.target.value.slice(0, DIRECTOR_MUSIC_MAX_LENGTH))}
                placeholder="例: 明るいアコースティックギターのBGM"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted"
              />
            </div>

            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
              <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
              各シーンのカメラワーク・アイデアはAIが1本の連続した映像指示に自動合成します（上から順番に展開されますが、厳密な秒数通りに切り替わる保証はありません）。秒数は合計尺・消費クレジットの計算に使われます。合計最大{DIRECTOR_MAX_TOTAL_SECONDS}秒。
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
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">LoRA（任意）</p>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => setLoraSource("none")}
              className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                loraSource === "none" ? "bg-neon-violet/15 text-foreground" : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              なし
            </button>
            <button
              type="button"
              disabled={busy || loraOptions.length === 0}
              onClick={() => setLoraSource("trained")}
              title={loraOptions.length === 0 ? "LoRA Studioで学習済みのMiniMax H3 LoRAがありません" : undefined}
              className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                loraSource === "trained" ? "bg-neon-violet/15 text-foreground" : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              学習済みから選ぶ
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setLoraSource("upload")}
              className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                loraSource === "upload" ? "bg-neon-violet/15 text-foreground" : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              アップロード
            </button>
          </div>

          {loraSource === "trained" && (
            <>
              <select
                value={loraId}
                onChange={(e) => setLoraId(e.target.value)}
                disabled={busy}
                className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">選択してください</option>
                {loraOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[11px] text-muted">LoRA Studio で学習済みの MiniMax H3 LoRA を生成に適用します。</p>
            </>
          )}

          {loraSource === "upload" && (
            <>
              <input
                type="file"
                accept=".safetensors"
                disabled={busy}
                onChange={(e) => setLoraUploadFile(e.target.files?.[0] ?? null)}
                className="mt-2 w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-xs file:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
              {loraUploadFile && (
                <p className="mt-1.5 text-[11px] text-muted">
                  {loraUploadFile.name}（{(loraUploadFile.size / 1024 / 1024).toFixed(1)} MB）
                </p>
              )}
              <p className="mt-2 text-[11px] text-muted">
                外部で用意した MiniMax H3 LoRA（.safetensors）を持ち込んで適用します。生成開始時にアップロードされます。
              </p>
            </>
          )}
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
          {!busy && gpuWarm && <WarmCountdownBanner remainingMs={gpuWarmMs} />}
          {busy && !queuedNext && (
            phase === "submitting" && loraSource === "upload" ? (
              // LoRAアップロード中（startDirectorJob内、/api/director/generate
              // を叩く前）だけはブラウザを閉じると本当に止まる特別な窓——
              // ジョブがまだサーバー側に一切存在しないため（2026-09-19、
              // ホスト指摘で追加）。ジョブ発行後(phase==="running")は
              // 通常どおり閉じても継続する。
              <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                LoRAファイルをアップロード中です。完了して生成が始まるまではブラウザを閉じたりタブを切り替えたりしないでください。途中で中断した場合は、もう一度同じファイルを選び直せば続きから再開できます。
              </p>
            ) : (
              <p className="mt-2 flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
                <Sparkles size={14} className="mt-0.5 shrink-0" />
                バックグラウンドで生成中です。もう一度ボタンを押すと、次の生成を予約できます。
              </p>
            )
          )}
          {queuedNext && (
            <div className="mt-2">
              <QueuedNextBanner onCancel={handleCancelQueue} />
            </div>
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
            <button
              type="button"
              onClick={() =>
                job.videoUrl &&
                downloadDirectorVideo(job.videoUrl, "ull_cinematic_director.mp4").catch((err) => {
                  console.error("[DirectorStudioTab] download failed:", err);
                  setErrorMessage("ダウンロードに失敗しました。");
                })
              }
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-neon-violet/40"
            >
              <Download size={14} />
              ダウンロード
            </button>
            {job.vramUsedGb != null && (
              <div className="mt-2 flex justify-center">
                <VramBadge gb={job.vramUsedGb} />
              </div>
            )}
          </div>
        )}

        {/* プロンプト表示は動画の完成を待たない: シーン合成(Gemini)はジョブ
            作成と同時に終わっており、動画のレンダリングより先に
            combinedPrompt が確定している。生成中(running)の段階からここに
            出すことで、レンダリング待ちの間に「編集して次を予約」できる
            ようにする（2026-09-15 ホスト報告 — 完成後にしか出ないと、実行中
            に次のジョブを編集して予約する運用ができなかった）。 */}
        {job?.combinedPrompt && (
          <div className="rounded-xl border border-border bg-background p-3">
            <div className="flex flex-col gap-3">
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
                {phase === "done" ? "このプロンプトを編集して再生成" : "このプロンプトを編集して次を予約"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
