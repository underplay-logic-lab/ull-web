"use client";

import { CopyButton } from "./CopyButton";
import { HelpNote } from "./HelpNote";
import { PromptLanguageSwitch } from "./PromptLanguageSwitch";
import { RefPhotoPicker, type RefPhoto } from "./RefPhotoPicker";
import { RestrictedChoiceModal, UnrestrictedToggle } from "./RestrictedChoiceModal";
import { TopupActions } from "./TopupActions";
import { PrevResultPanel } from "@/components/studio/PrevResultPanel";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DIRECTOR_LORA_ENABLED } from "@/lib/featureFlags";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Clapperboard,
  Download,
  Music,
  ImagePlus,
  LogIn,
  Pencil,
  RefreshCw,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import {
  DIRECTOR_ASPECTS,
  DIRECTOR_AUDIO_MAX_BYTES,
  DIRECTOR_CAMERA_MOVES,
  DIRECTOR_DIALOGUE_MAX_LENGTH,
  DIRECTOR_MAX_AUDIO_SECONDS,
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
  directorUnrestrictedScriptSurcharge,
  directorAspectDims,
  directorExtraRefSurcharge,
  directorRefVideoSurcharge,
  directorTotalDurationS,
  DIRECTOR_REF_VIDEO_MAX_BYTES,
  DIRECTOR_REF_VIDEO_MAX_S,
  DIRECTOR_REF_VIDEO_MIN_S,
  DIRECTOR_REF_VIDEO_ROLES,
  DIRECTOR_REF_VOICE_MAX_BYTES,
  DIRECTOR_REF_VOICE_MAX_S,
  type DirectorRefVideoRole,
  type DirectorAspectId,
  type DirectorCameraMoveId,
  type DirectorQualityMode,
  type DirectorReferenceMode,
  type DirectorScene,
} from "@/lib/directorPricing";
import { CINEMATIC_MODE_BY_ID, cinematicMegapixelsForDuration, cinematicSafeDimensions } from "@/lib/cinematicPricing";
import {
  pollDirectorJob,
  DirectorJobNotFoundError,
  startDirectorJob,
  regenerateDirectorJob,
  downloadDirectorVideo,
  uploadDirectorLoraFile,
  forgetUploadedDirectorLora,
  type DirectorApiError,
  type DirectorScriptEngine,
  type DirectorJobStatus,
  type DirectorLoraSelection,
  type DirectorMediaOptions,
} from "@/lib/directorApi";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import {
  loadStudioSession,
  saveStudioSession,
  SessionResetConfirmModal,
  StudioSessionList,
  type StudioSessionEntry,
} from "@/components/studio/StudioSessionList";
import { VramBadge } from "@/components/studio/VramBadge";
import AutoDownloadToggle from "@/components/studio/AutoDownloadToggle";
import GenerationCaveat from "@/components/studio/GenerationCaveat";
import { armAutoDownload, runAutoDownload, takeAutoDownload } from "@/lib/autoDownload";
import { advanceStudioQueue, cancelStudioQueue } from "@/lib/studioQueue";
import {
  DIRECTOR_LORA_EVENT,
  clearDirectorLora,
  peekDirectorLora,
  requestStudioHandoff,
  takeStudioBatchHandoff,
  takeDirectorAudio,
  type DirectorLoraHandoff,
} from "@/lib/studioHandoff";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";
import { useLocalWarmCountdown } from "@/hooks/useLocalWarmCountdown";
import {
  QueueChoiceModal,
  QueuedNextBanner,
  QueueNextButtonLabel,
  WarmCountdownBanner,
} from "@/components/studio/QueueChoiceModal";

type Phase = "idle" | "submitting" | "running" | "done" | "error";

const JOB_KEY = "director-active-job";
// このブラウザで予約し、まだ画面に出していない予約（2026-10-03〜予約はサーバー側）。
// タブを閉じている間に始まった・終わった分を、開き直したときに順に追いかけるために残す。
const RESERVED_KEY = "director-reserved-jobs";
type TrackedReservation = { id: string; label: string };

/** 「今回の生成」一覧の見出し（作り直しは元の画像が手元に無いので固定文言）。 */
function snapshotLabel(snapshot: { uiMode: string; image?: File }): string {
  return snapshot.uiMode === "regen" ? "作り直し" : snapshot.image instanceof File ? snapshot.image.name : "";
}
const SESSION_KEY = "director-session-jobs";
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

/** 音声・動画ファイルの長さ（秒）をブラウザで測る。読めなければ null。 */
function measureAudioDuration(file: File, kind: "audio" | "video" = "audio"): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = kind === "video" ? document.createElement("video") : new Audio();
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
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
  badge,
}: {
  file: File | null;
  previewUrl: string | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
  /** 角に出す名前（顔写真として使うときの「Picture 1」）。 */
  badge?: string;
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
          {badge && (
            <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">{badge}</span>
          )}
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
        <TopupActions cost={cost} onClose={onClose} />
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

/** 保存するファイル名。シードが分かれば入れる（あとでどの条件の動画か分かるように、2026-10-01〜）。 */
function directorFilename(seed: number | null): string {
  return seed ? `ull_cinematic_director_s${seed}.mp4` : "ull_cinematic_director.mp4";
}

export function DirectorStudioTab() {
  const { user } = useSupabaseUser();
  const { isAdmin } = useIsAdmin(user);
  // LoRA 欄は一般には伏せている（featureFlags.ts）。admin には出して確かめられるようにする（2026-10-03）。
  const loraUiEnabled = DIRECTOR_LORA_ENABLED || isAdmin;
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();

  const [image, setImage] = useState<File | null>(null);
  const imagePreview = useObjectUrl(image);
  // 参照画像の実寸 → 出力解像度の予告（route と同じ cinematicSafeDimensions）。
  // File ごとに持ち、現在の image と一致するときだけ使う（effect 内の同期 reset を避ける）。
  const [measured, setMeasured] = useState<{ file: File; width: number; height: number } | null>(null);
  const imageDims = image && measured?.file === image ? measured : null;
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    createImageBitmap(image)
      .then((bmp) => {
        if (!cancelled) setMeasured({ file: image, width: bmp.width, height: bmp.height });
        bmp.close?.();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [image]);
  const [scenes, setScenes] = useState<DirectorScene[]>([newScene()]);

  // 持ち込み音声（歌・セリフ、2026-10-05）。入れると尺は音声の長さになり、口を音声に合わせる。
  const [audio, setAudio] = useState<{ file: File; durationS: number } | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [audioDragging, setAudioDragging] = useState(false);
  const handleAudioSelected = async (file: File | null | undefined) => {
    if (!file) return;
    setAudioError(null);
    if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i.test(file.name)) {
      setAudioError("音声ファイル（WAV・MP3・M4A・FLAC など）を選んでください。");
      return;
    }
    if (file.size > DIRECTOR_AUDIO_MAX_BYTES) {
      setAudioError(
        `ファイルが大きすぎます（${Math.round(DIRECTOR_AUDIO_MAX_BYTES / 1024 / 1024)}MB まで）。MP3 などに変換してからお試しください。`,
      );
      return;
    }
    const d = await measureAudioDuration(file);
    if (!d) {
      setAudioError("この音声は読み込めませんでした。WAV か MP3 に変換してからお試しください。");
      return;
    }
    if (d > DIRECTOR_MAX_AUDIO_SECONDS + 0.5) {
      setAudioError(
        `音声は ${DIRECTOR_MAX_AUDIO_SECONDS} 秒までです（このファイルは約 ${Math.round(d)} 秒）。切り詰めてからお試しください。`,
      );
      return;
    }
    setAudio({ file, durationS: Math.min(DIRECTOR_MAX_AUDIO_SECONDS, d) });
  };

  // 画像の使い方（2026-10-05）: first_frame = 最初のフレームにする／reference = 顔写真として参照（構図は自由・長尺でも顔を保つ）。
  const [referenceMode, setReferenceMode] = useState<DirectorReferenceMode>("first_frame");
  const [aspect, setAspect] = useState<DirectorAspectId>("16:9");
  // 「顔写真として使う」で足す写真（2 枚目以降・最大 8 枚、2026-10-05）。同じ人物の角度・表情違いを入れるほど似る。
  // 足した写真と、それぞれの使い方（人物／持ち物／場所／画風）。欄は Photo Director と共通の RefPhotoPicker。
  const [refs, setRefs] = useState<RefPhoto[]>([]);
  const extraRefs = useMemo(() => refs.map((r) => r.file), [refs]);
  const extraRefRoles = useMemo(() => refs.map((r) => r.role), [refs]);
  // 手本の動画（動き／カメラ）と声の手本（2026-10-06）。参照モードだけ。
  const [refVideo, setRefVideo] = useState<{ file: File; durationS: number } | null>(null);
  const [refVideoRole, setRefVideoRole] = useState<DirectorRefVideoRole>("motion");
  const [refVoice, setRefVoice] = useState<File | null>(null);
  const [refMediaError, setRefMediaError] = useState<string | null>(null);
  const refVideoInputRef = useRef<HTMLInputElement>(null);
  const refVoiceInputRef = useRef<HTMLInputElement>(null);
  const handleRefVideoSelected = async (file: File | null | undefined) => {
    if (!file) return;
    setRefMediaError(null);
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
      return setRefMediaError("動画ファイル（MP4・MOV・WebM など）を選んでください。");
    }
    if (file.size > DIRECTOR_REF_VIDEO_MAX_BYTES) {
      return setRefMediaError(
        `動画が大きすぎます（${Math.round(DIRECTOR_REF_VIDEO_MAX_BYTES / 1024 / 1024)}MB まで）。短く切るか画質を下げてからお試しください。`,
      );
    }
    const d = await measureAudioDuration(file, "video");
    if (!d) return setRefMediaError("この動画は読み込めませんでした。MP4 に変換してからお試しください。");
    if (d < DIRECTOR_REF_VIDEO_MIN_S) return setRefMediaError(`手本の動画は ${DIRECTOR_REF_VIDEO_MIN_S} 秒以上にしてください。`);
    if (d > DIRECTOR_REF_VIDEO_MAX_S + 0.5) {
      return setRefMediaError(
        `手本の動画は ${DIRECTOR_REF_VIDEO_MAX_S} 秒までです（このファイルは約 ${Math.round(d)} 秒）。切り詰めてからお試しください。`,
      );
    }
    setRefVideo({ file, durationS: Math.min(DIRECTOR_REF_VIDEO_MAX_S, d) });
  };
  const handleRefVoiceSelected = async (file: File | null | undefined) => {
    if (!file) return;
    setRefMediaError(null);
    if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i.test(file.name)) {
      return setRefMediaError("声の手本は音声ファイル（WAV・MP3・M4A など）を選んでください。");
    }
    if (file.size > DIRECTOR_REF_VOICE_MAX_BYTES) {
      return setRefMediaError(`声の手本が大きすぎます（${Math.round(DIRECTOR_REF_VOICE_MAX_BYTES / 1024 / 1024)}MB まで）。`);
    }
    const d = await measureAudioDuration(file);
    if (!d) return setRefMediaError("この音声は読み込めませんでした。WAV か MP3 に変換してからお試しください。");
    if (d > DIRECTOR_REF_VOICE_MAX_S + 0.5) {
      return setRefMediaError(`声の手本は ${DIRECTOR_REF_VOICE_MAX_S} 秒までです（数秒で足ります）。`);
    }
    setRefVoice(file);
  };
  // 素材づくりから受け取る（2026-10-05）: 先頭を参照画像、残りを追加の写真にして「顔写真として使う」にする。
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  useEffect(() => {
    const h = takeStudioBatchHandoff("director");
    if (!h || h.files.length === 0) return;
    queueMicrotask(() => {
      setImage(h.files[0]);
      setReferenceMode("reference");
      setRefs(h.files.slice(1, 9).map((file): RefPhoto => ({ file, role: "person" })));
      setHandoffNotice(`${h.source}を受け取りました。${h.hint ?? ""}`);
    });
  }, []);
  // 曲づくりから曲を受け取る（2026-10-06）: 音声欄に入れて、歌の動画向きの「顔写真として使う」にする。
  const [pendingAudio] = useState<File | null>(() => takeDirectorAudio());
  useEffect(() => {
    if (!pendingAudio) return;
    // 受け取りは開いたときの 1 回だけ（state の更新は効果の外＝マイクロタスクで）。
    queueMicrotask(() => {
      setReferenceMode("reference");
      setHandoffNotice("曲づくりの曲を音声に入れました。歌う人の顔写真を入れてください。");
      void handleAudioSelected(pendingAudio);
    });
  }, [pendingAudio]);
  const media: DirectorMediaOptions = {
    audio,
    referenceMode,
    aspect: referenceMode === "reference" ? aspect : "image",
    extraRefs: referenceMode === "reference" ? extraRefs : [],
    extraRefRoles: referenceMode === "reference" ? extraRefRoles : [],
    refVideo: referenceMode === "reference" && refVideo ? { ...refVideo, role: refVideoRole } : null,
    refVoice: referenceMode === "reference" && !audio ? refVoice : null,
  };

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
  // 既定は「おまかせ」（2026-10-02 ホスト判断: 初心者向け・失敗しにくい・台本代込みで少し高い。
  // 直接書くモードは上級者向けと明記する。1 文だけで 15 秒を作り、後半で別人になった実例を受けて）。
  const [uiMode, setUiMode] = useState<UiMode>("advanced");
  const [promptDraft, setPromptDraft] = useState("");
  // 編集で読み込んだジョブの英語の原文（日本語訳を読み込んだときに戻せるように）。
  const [promptEnglish, setPromptEnglish] = useState<string | null>(null);
  const [promptJa, setPromptJa] = useState<string | null>(null);
  const [promptDraftDurationS, setPromptDraftDurationS] = useState(DIRECTOR_SECONDS_PER_SCENE);
  // 「この動画をもとに調整する」（2026-10-01〜）: 完了した動画から入ったときだけ持つ。
  // この間は元の動画と同じシード・同じ参照画像で作り直す（画像の入れ直しは不要）。
  const [adjustBase, setAdjustBase] = useState<{ jobId: string; seed: number | null; english: string } | null>(null);
  // 編集欄は画面の上の方にあるので、結果の下のボタンから入ったらそこまで連れて行く（押しても反応が無いように見えた、2026-10-02）。
  const promptEditorRef = useRef<HTMLTextAreaElement>(null);

  // Advanced モード（2026-09-18追加。TODO(advanced-gate): 月額プラン限定に
  // する場合はこのモードを選べる条件をここに追加する — 今回は未実装）。
  const [conceptText, setConceptText] = useState("");
  const [conceptDurationS, setConceptDurationS] = useState(DIRECTOR_SECONDS_PER_SCENE);

  // LoRA（2026-09-18追加。全モード共通・任意）。①LoRA Studio の完了画面から渡された LoRA
  // ②外部で用意した .safetensors をこの場でアップロード、の2系統を持つ。
  // 学習済みの一覧は 2026-10-03 に外した（いつまでも残っていると誤解させる。完成品は R2 で 14 日）。
  // LoRA Studio の「LoRA を保存して動画を作る」が、このブラウザのタブにだけ渡す（lib/studioHandoff.ts）。
  type LoraSource = "none" | "trained" | "upload";
  const [loraSource, setLoraSource] = useState<LoraSource>("none");
  const [trainedLora, setTrainedLora] = useState<DirectorLoraHandoff | null>(null);
  // トリガーワード（2026-10-04、ホスト要望「プロンプトに毎回打ち込むのは忘れそう」）。AI が指示文を書き直しても
  // 消えないよう、サーバー／ワーカーが最終の文に無ければ先頭に足す。LoRA Studio から渡したときは自動で入る。
  const [loraTrigger, setLoraTrigger] = useState("");
  const loraId = trainedLora?.loraJobId ?? "";
  const [loraUploadFile, setLoraUploadFile] = useState<File | null>(null);
  // 2026-09-19: 「アップロード」と「生成」を別操作に分離した（1GB級の
  // アップロード中にブラウザを閉じるとジョブが一度も作られないまま止まる
  // 問題への対策、ホスト指摘）。ファイルを選んだだけでは生成できず、この
  // アップロードが成功して volumePath を得るまでは loraSelection が
  // "none" 扱いになり canRun が false のまま——ユーザーは必ず「アップロード」
  // →完了確認→「生成」の順で操作することになる。
  const [loraUploadedKey, setLoraUploadedKey] = useState<string | null>(null);
  const [loraUploading, setLoraUploading] = useState(false);
  const [loraUploadError, setLoraUploadError] = useState<string | null>(null);
  // アップロード進捗（2026-09-19追加、ホスト指摘: 1GB級のファイルを
  // 「アップロード中...」の文字だけで待たせると、固まっているのか進んで
  // いるのか分からない）。バイト数（loaded/total）で保持し、表示側で%へ
  // 変換する。
  const [loraUploadBytes, setLoraUploadBytes] = useState<{ loaded: number; total: number } | null>(null);
  const loraSelection: DirectorLoraSelection =
    loraSource === "trained" && loraId
      ? { source: "trained", loraId, triggerWord: loraTrigger.trim() || undefined }
      : loraSource === "upload" && loraUploadedKey
        ? { source: "upload", r2Key: loraUploadedKey, triggerWord: loraTrigger.trim() || undefined }
        : { source: "none" };

  // LoRAソースを切り替える。「アップロード」から他のソースへ離れる時は
  // 選択中ファイル・アップロード状態を破棄する——破棄しないと、後で
  // 「アップロード」に戻った際に前回選んだファイル名とアップロード
  // 完了チェックだけが残り、確認ボタンが出ない（loraUploadedKey
  // が真のまま）ため選び直しができなくなるバグがあった
  // （2026-09-19、ホスト報告）。
  const selectLoraSource = (next: LoraSource) => {
    if (loraSource === "upload" && next !== "upload") {
      setLoraUploadFile(null);
      setLoraUploadedKey(null);
      setLoraUploadError(null);
      setLoraUploadBytes(null);
    }
    setLoraSource(next);
  };

  // 持ち込み LoRA はこのタブを開いている間は使い回す（閉じたら消える・開いたままでも 1 日で消える、2026-10-04）。
  // 消えていたとサーバーに言われたら、アップロード済みの印を外してもう一度アップロードしてもらう。
  const forgetUploadedLoraIfGone = useCallback(
    (message: string | undefined) => {
      if (!message?.includes("もう一度アップロード")) return;
      if (loraUploadFile) forgetUploadedDirectorLora(loraUploadFile);
      setLoraUploadedKey(null);
      setLoraUploadBytes(null);
    },
    [loraUploadFile],
  );

  const handleUploadLora = async () => {
    if (!user || !loraUploadFile || loraUploading) return;
    setLoraUploading(true);
    setLoraUploadError(null);
    setLoraUploadBytes({ loaded: 0, total: loraUploadFile.size });
    try {
      const { r2Key } = await uploadDirectorLoraFile(loraUploadFile, (loaded, total) =>
        setLoraUploadBytes({ loaded, total }),
      );
      setLoraUploadedKey(r2Key);
    } catch (err) {
      setLoraUploadError(err instanceof Error ? err.message : "アップロードに失敗しました。");
    } finally {
      setLoraUploading(false);
    }
  };
  useEffect(() => {
    const receive = (h: DirectorLoraHandoff | null) => {
      if (!h) return;
      setTrainedLora(h);
      setLoraSource("trained");
      if (h.triggerWords?.length) setLoraTrigger(h.triggerWords.join(", "));
      setLoraUploadFile(null);
      setLoraUploadedKey(null);
      setLoraUploadError(null);
      setLoraUploadBytes(null);
    };
    receive(peekDirectorLora());
    const onLora = (e: Event) => receive((e as CustomEvent<DirectorLoraHandoff>).detail ?? null);
    window.addEventListener(DIRECTOR_LORA_EVENT, onLora);
    return () => window.removeEventListener(DIRECTOR_LORA_EVENT, onLora);
  }, []);
  const removeTrainedLora = () => {
    clearDirectorLora();
    setTrainedLora(null);
    if (loraSource === "trained") setLoraSource("none");
  };

  const resumedJobId = useMemo(() => loadFormState<PersistedJob>(JOB_KEY)?.jobId || null, []);
  const [phase, setPhase] = useState<Phase>(resumedJobId ? "running" : "idle");
  const [jobId, setJobId] = useState<string | null>(resumedJobId);
  const [job, setJob] = useState<DirectorJobStatus | null>(null);
  // 前の結果（2026-09-29）: 予約した次の生成が始まっても直前の完了分を別枠で見せる（PrevResultPanel）。
  const [peekId, setPeekId] = useState<string | null>(null);
  const jobRefForPeek = useRef<typeof job>(null);
  useEffect(() => {
    jobRefForPeek.current = job;
  }, [job]);
  // 完了後の videoUrl は読んだ時点の署名付き URL で、R2 への移動や期限切れで無効になる
  // （2026-09-24）。保存・超解像への受け渡し・再生失敗のときはジョブを読み直して取り直す。
  const freshVideoUrl = useCallback(async (): Promise<string | null> => {
    if (!job?.jobId) return job?.videoUrl ?? null;
    try {
      const next = await pollDirectorJob(job.jobId);
      if (next.videoUrl) setJob((cur) => (cur && cur.jobId === next.jobId ? { ...cur, videoUrl: next.videoUrl } : cur));
      return next.videoUrl ?? job.videoUrl;
    } catch {
      return job.videoUrl;
    }
  }, [job]);
  const videoReloadsRef = useRef(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // 「今回の生成」（2026-09-23 ホスト方針）: 順番待ち・並列で続けて出したジョブだけを
  // 並べ、改めて生成するときは確認のうえ空にする。自動 DL は廃止（一覧から戻れる）。
  const [sessionJobs, setSessionJobs] = useState<StudioSessionEntry[]>(() => loadStudioSession(SESSION_KEY));
  const sessionJobsRef = useRef<StudioSessionEntry[]>(sessionJobs);
  const commitSession = useCallback((next: StudioSessionEntry[]) => {
    sessionJobsRef.current = next;
    setSessionJobs(next);
    saveStudioSession(SESSION_KEY, next);
  }, []);
  const [sessionResetOpen, setSessionResetOpen] = useState(false);
  const pendingFreshRef = useRef<QueuedSnapshot | null>(null);
  // 改めて生成したジョブの id。完了時に前の並びを消すための印。
  const freshJobIdRef = useRef<string | null>(null);


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
        media: DirectorMediaOptions;
      }
    | {
        uiMode: "prompt";
        image: File;
        rawPrompt: string;
        rawDurationS: number;
        quality: DirectorQualityMode;
        lora: DirectorLoraSelection;
        media: DirectorMediaOptions;
      }
    | {
        uiMode: "advanced";
        image: File;
        conceptText: string;
        rawDurationS: number;
        quality: DirectorQualityMode;
        lora: DirectorLoraSelection;
        media: DirectorMediaOptions;
      }
    | {
        // 完了した動画から作り直す（参照画像・台本・LoRA はサーバーが元のジョブから引き継ぐ）。
        uiMode: "regen";
        baseJobId: string;
        variation: "new_seed" | "same_seed";
        rawPrompt?: string;
        rawDurationS?: number;
        quality?: DirectorQualityMode;
        /** 持ち込み LoRA は使ったら消すので、作り直しでは今アップロードした分を使う（2026-10-04）。 */
        lora?: DirectorLoraSelection;
        scriptEngine?: DirectorScriptEngine;
      };
  // 制限なしモード（2026-10-06）: シーンで組むときに最初から選ぶスイッチと、断られたときの「解除しますか？」。
  const [unrestricted, setUnrestricted] = useState(false);
  const [restrictedRetry, setRestrictedRetry] = useState<{
    snapshot: QueuedSnapshot;
    opts: { priority?: boolean; continuation?: boolean; queue?: boolean };
  } | null>(null);
  const unrestrictedSurcharge = directorUnrestrictedScriptSurcharge(knobs);
  const withEngine = (s: QueuedSnapshot, engine: DirectorScriptEngine): QueuedSnapshot =>
    s.uiMode === "regen" ? { ...s, scriptEngine: engine } : { ...s, media: { ...s.media, scriptEngine: engine } };
  // 予約（順番待ち）はサーバー側（2026-10-03、lib/studioQueue.server.ts）。予約した時点で課金してジョブ行を
  // reserved で作り、前のジョブが終わるとサーバーが起動する（タブを閉じても進む）。それまでは画面のメモリにだけあり、
  // 閉じると消えていた。reservedIds = DB の reserved（古い順・表示用）。
  const [reservedIds, setReservedIds] = useState<string[]>([]);
  // 予約の送信中（台本の合成・画像のアップロード中）の件数。バナーの件数に足す。
  const [reserving, setReserving] = useState(0);
  const [queueError, setQueueError] = useState<string | null>(null);
  // このブラウザで予約し、まだ画面に出していない分（RESERVED_KEY に残す）。完了を見たら次はここから追いかける。
  const trackedInit = useMemo(
    () =>
      (loadFormState<{ items: TrackedReservation[] }>(RESERVED_KEY)?.items ?? []).filter(
        (x): x is TrackedReservation => Boolean(x) && typeof x.id === "string",
      ),
    [],
  );
  const trackedRef = useRef<TrackedReservation[]>(trackedInit);

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
  // 音声を入れたときは尺＝音声の長さ（どのモードでも。route と同じ）。
  const audioBreakdown = useMemo(
    () =>
      audio
        ? directorCostBreakdownForDuration({
            totalDurationS: Math.ceil(audio.durationS),
            mode: qualityMode,
            knobs,
          })
        : null,
    [audio, qualityMode, knobs],
  );
  // 調整（元の動画から作り直す）は元のジョブの音声・尺を引き継ぐので、今の音声欄は使わない。
  const useAudio = Boolean(audioBreakdown) && !(uiMode === "prompt" && adjustBase);
  const breakdown =
    audioBreakdown && useAudio
      ? audioBreakdown
      : uiMode === "prompt"
        ? promptBreakdown
        : uiMode === "advanced"
          ? conceptBreakdown
          : sceneBreakdown;
  // Advanced（Qwen台本生成）は動画本体とは別のGPUコンテナを1回起動する分の
  // 追加クレジットが乗る（directorPricing.ts::directorQwenScriptSurcharge）。
  // 参照写真の上乗せ（route と同じ関数）。作り直しは元のジョブの写真を使うので、ここでは今の欄の枚数で見積もる。
  const extraRefCount = referenceMode === "reference" ? extraRefs.length : 0;
  const cost =
    breakdown.credits +
    directorExtraRefSurcharge(breakdown.credits, extraRefCount, knobs) +
    (referenceMode === "reference" && refVideo
      ? directorRefVideoSurcharge(breakdown.credits, refVideo.durationS, breakdown.totalDurationS, knobs)
      : 0) +
    (uiMode === "advanced" ? directorQwenScriptSurcharge(knobs) : 0) +
    (unrestricted && uiMode === "scenes" ? unrestrictedSurcharge : 0);
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < cost;
  const busy = phase === "submitting" || phase === "running";

  const handleShowSession = (id: string) => {
    if (id === jobId) return;
    if (busy) {
      setPeekId(id);
      return;
    }
    setErrorMessage(null);
    setJob(null);
    setJobId(id);
    setPhase("running"); // ポーリングが 1 回で completed を検知して done に落とす
  };

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
    setPromptEnglish(job.combinedPrompt);
    setPromptJa(job.combinedPromptJa);
    setPromptDraftDurationS(job.totalDurationS ?? DIRECTOR_SECONDS_PER_SCENE);
    setAdjustBase(
      job.status === "completed" && job.regenerable ? { jobId: job.jobId, seed: job.seed, english: job.combinedPrompt } : null,
    );
    if (job.quality) setQualityMode(job.quality);
    setUiMode("prompt");
    setTimeout(() => {
      promptEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      promptEditorRef.current?.focus({ preventScroll: true });
    }, 50);
  }, [job]);
  const exitPromptMode = useCallback(() => {
    setAdjustBase(null);
    setPromptEnglish(null);
    setPromptJa(null);
    setUiMode("advanced");
  }, []);

  // LoRAのソースを選んだのに中身（選択/アップロード完了）が無いままだと、
  // 意図せず「なし」で生成されてしまう——選んだ以上は完了させてから送信
  // させる。アップロードはファイルを選んだだけでは不十分で、
  // handleUploadLora が成功してvolumePathを得るまで未完了扱いにする
  // （2026-09-19、アップロードと生成を別操作に分離）。
  const loraSelectionIncomplete =
    (loraSource === "trained" && !loraId) || (loraSource === "upload" && !loraUploadedKey);

  // 不足していれば入力が揃う前でもチャージへ案内する（他タブと同じ。2026-09-28）。実行中は順番待ちを選べるので出さない。
  const chargeFirst = insufficientCredits && !busy;
  const adjusting = uiMode === "prompt" && adjustBase !== null;
  const canRun =
    (Boolean(image) || adjusting) &&
    cost > 0 &&
    !loraSelectionIncomplete &&
    (uiMode === "prompt"
      ? promptDraft.trim().length > 0
      : uiMode === "advanced"
        ? conceptText.trim().length > 0
        : scenes.every((s) => s.text.trim().length > 0));

  const buildSnapshotRaw = (): QueuedSnapshot | null => {
    if (adjusting && adjustBase) {
      return {
        uiMode: "regen",
        baseJobId: adjustBase.jobId,
        variation: "same_seed",
        rawPrompt: promptDraft.trim(),
        rawDurationS: promptDraftDurationS,
        quality: qualityMode,
        lora: loraSelection.source === "upload" ? loraSelection : undefined,
      };
    }
    if (!image) return null;
    if (uiMode === "prompt") {
      return {
        uiMode: "prompt",
        image,
        rawPrompt: promptDraft.trim(),
        rawDurationS: promptDraftDurationS,
        quality: qualityMode,
        lora: loraSelection,
        media,
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
        media,
      };
    }
    return {
      uiMode: "scenes",
      image,
      scenes,
      quality: qualityMode,
      musicDirection: musicDirection.trim(),
      lora: loraSelection,
      media,
    };
  };

  // 制限なしのスイッチ（シーンで組むときだけ）を入れて送る内容を決める。
  const buildSnapshot = (): QueuedSnapshot | null => {
    const s = buildSnapshotRaw();
    return s && unrestricted && uiMode === "scenes" ? withEngine(s, "unrestricted") : s;
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
    if (sessionJobsRef.current.length > 0) {
      pendingFreshRef.current = snapshot;
      setSessionResetOpen(true);
      return;
    }
    void runGenerate(snapshot);
  };

  // 「別パターンで作り直す」: 台本・参照画像・尺・LoRA・画質はそのまま、シードだけ変える。
  // 前の動画は「前回の結果」として並べて見比べられるよう continuation で出す。
  const regenCost = (() => {
    if (!job?.regenerable || !job.totalDurationS) return 0;
    const v = directorCostBreakdownForDuration({ totalDurationS: job.totalDurationS, mode: job.quality ?? qualityMode, knobs }).credits;
    return (
      v +
      directorExtraRefSurcharge(v, job.extraRefCount, knobs) +
      directorRefVideoSurcharge(v, job.refVideoDurationS, job.totalDurationS, knobs)
    );
  })();
  const handleRegenerate = () => {
    if (!user || !job?.regenerable || busy) return;
    if (!creditsLoading && (credits ?? 0) < regenCost) return setChargeOpen(true);
    void runGenerate(
      {
        uiMode: "regen",
        baseJobId: job.jobId,
        variation: "new_seed",
        lora: loraSelection.source === "upload" ? loraSelection : undefined,
      },
      { continuation: true },
    );
  };

  const handleQueueParallel = () => {
    const snapshot = buildSnapshot();
    if (!snapshot) return;
    setQueueChoiceOpen(false);
    const surcharge = directorPriorityParallelSurcharge(knobs, cost);
    if (!creditsLoading && (credits ?? 0) < cost + surcharge) {
      setChargeOpen(true);
      return;
    }
    void runGenerate(snapshot, { priority: true, continuation: true });
  };

  // snapshot を明示的に渡す設計: キュー待ちの「次の1件」は予約した時点の
  // image/scenes（またはprompt）を使う必要があり、発火時点の（変わっている
  // かもしれない）現在の state を読んではいけない。ポーリングの長寿命な
  // useEffect からも呼ぶため、参照が安定するよう useCallback にする。
  // スナップショットから生成 API を呼ぶ（その場の生成・並列・予約で共通）。
  const startFromSnapshot = useCallback(
    async (snapshot: QueuedSnapshot, opts: { priority?: boolean; queue?: boolean } = {}) => {
      if (!user) throw new Error("ログインが必要です。");
      return snapshot.uiMode === "regen"
        ? regenerateDirectorJob({
            baseJobId: snapshot.baseJobId,
            variation: snapshot.variation,
            rawPrompt: snapshot.rawPrompt,
            rawDurationS: snapshot.rawDurationS,
            quality: snapshot.quality,
            priority: opts.priority,
            queue: opts.queue,
            lora: snapshot.lora,
            scriptEngine: snapshot.scriptEngine,
          })
        : snapshot.uiMode === "prompt"
          ? startDirectorJob({
              userId: user.id,
              image: snapshot.image,
              rawPrompt: snapshot.rawPrompt,
              rawDurationS: snapshot.rawDurationS,
              quality: snapshot.quality,
              priority: opts.priority,
              queue: opts.queue,
              lora: snapshot.lora,
              ...snapshot.media,
            })
          : snapshot.uiMode === "advanced"
            ? startDirectorJob({
                userId: user.id,
                image: snapshot.image,
                conceptText: snapshot.conceptText,
                rawDurationS: snapshot.rawDurationS,
                quality: snapshot.quality,
                priority: opts.priority,
                queue: opts.queue,
                lora: snapshot.lora,
                ...snapshot.media,
              })
            : startDirectorJob({
                userId: user.id,
                image: snapshot.image,
                scenes: snapshot.scenes,
                musicDirection: snapshot.musicDirection || undefined,
                quality: snapshot.quality,
                priority: opts.priority,
                queue: opts.queue,
                lora: snapshot.lora,
                ...snapshot.media,
              });
    },
    [user],
  );

  const runGenerate = useCallback(
    async (snapshot: QueuedSnapshot, opts: { priority?: boolean; continuation?: boolean } = {}) => {
      if (!user) return;
      const prevJob = jobRefForPeek.current;
      if (opts.continuation && prevJob && prevJob.status === "completed") setPeekId(prevJob.jobId);
      setPhase("submitting");
      setErrorMessage(null);
      setJob(null);

      try {
        const res = await startFromSnapshot(snapshot, { priority: opts.priority });
        broadcastCreditsUpdate(user.id, res.remainingCredits);
        {
          const entry: StudioSessionEntry = { id: res.jobId, createdAt: new Date().toISOString(), label: snapshotLabel(snapshot) };
          commitSession([...sessionJobsRef.current.filter((e) => e.id !== res.jobId), entry]);
          freshJobIdRef.current = opts.continuation ? null : res.jobId;
        }
        armAutoDownload(res.jobId);
        setJobId(res.jobId);
        setPhase("running");
      } catch (err) {
        const e = err as DirectorApiError;
        console.error("[DirectorStudioTab] start failed:", e);
        const remaining = e.remainingCredits;
        if (typeof remaining === "number") broadcastCreditsUpdate(user.id, remaining);
        if (e.code === "restricted") {
          setPhase("idle");
          setRestrictedRetry({ snapshot, opts });
          return;
        }
        setPhase("error");
        setErrorMessage(e.message || "ジョブの作成に失敗しました。");
        if (e.message?.includes("クレジット")) setChargeOpen(true);
        forgetUploadedLoraIfGone(e.message);
      }
    },
    [user, commitSession, startFromSnapshot, forgetUploadedLoraIfGone],
  );

  // サーバーが起動した予約のジョブへ画面を切り替える（続けて出した生成として一覧に足す）。
  const followJob = useCallback(
    (id: string) => {
      const prevJob = jobRefForPeek.current;
      if (prevJob && prevJob.status === "completed") setPeekId(prevJob.jobId);
      const tracked = trackedRef.current.find((t) => t.id === id);
      trackedRef.current = trackedRef.current.filter((t) => t.id !== id);
      saveFormState(RESERVED_KEY, { items: trackedRef.current });
      const entry: StudioSessionEntry = { id, createdAt: new Date().toISOString(), label: tracked?.label ?? "" };
      commitSession([...sessionJobsRef.current.filter((e) => e.id !== id), entry]);
      setErrorMessage(null);
      setJob(null);
      setJobId(id);
      setPhase("running");
    },
    [commitSession],
  );

  // 順番が来ていれば次を起動させ（DB トリガーが先に起動していても害は無い）、予約一覧を取り直す。
  // follow: 起動した（またはタブを閉じている間に始まった）予約のジョブへ画面を切り替える。
  const advanceAndFollow = useCallback(
    async (follow: boolean) => {
      const q = await advanceStudioQueue("director");
      if (!q) return;
      setReservedIds(q.reserved);
      if (!follow) return;
      const moved = trackedRef.current.filter((t) => !q.reserved.includes(t.id)).map((t) => t.id);
      const next = q.started && moved.includes(q.started) ? q.started : (moved[0] ?? null);
      if (next) followJob(next);
    },
    [followJob],
  );

  // 開いたとき: 順番が来ていれば起動し、予約一覧を出す。復元したジョブが無ければ、閉じている間に始まった予約を追いかける
  // （復元したジョブがあれば、その完了を見たときに追いかける）。状態の更新は API の応答後だけ。
  useEffect(() => {
    if (!user) return;
    queueMicrotask(() => void advanceAndFollow(!resumedJobId));
  }, [user, resumedJobId, advanceAndFollow]);

  // 予約する（サーバー側の順番待ち、2026-10-03）。その場で課金され、何も動いていなければすぐ始まる
  // （そのときは画面をそのジョブへ切り替える）。
  const handleQueueWait = async () => {
    const snapshot = buildSnapshot();
    if (!snapshot || !user) return;
    setQueueChoiceOpen(false);
    if (insufficientCredits) return setChargeOpen(true);
    await reserveSnapshot(snapshot);
  };

  const reserveSnapshot = async (snapshot: QueuedSnapshot) => {
    if (!user) return;
    setQueueError(null);
    setReserving((n) => n + 1);
    try {
      const res = await startFromSnapshot(snapshot, { queue: true });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      armAutoDownload(res.jobId);
      trackedRef.current = [
        ...trackedRef.current.filter((t) => t.id !== res.jobId),
        { id: res.jobId, label: snapshotLabel(snapshot) },
      ];
      saveFormState(RESERVED_KEY, { items: trackedRef.current });
      if (res.reserved) setReservedIds((prev) => (prev.includes(res.jobId) ? prev : [...prev, res.jobId]));
      else followJob(res.jobId);
    } catch (err) {
      const e = err as DirectorApiError;
      console.error("[DirectorStudioTab] reserve failed:", e);
      if (typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
      if (e.code === "restricted") setRestrictedRetry({ snapshot, opts: { queue: true } });
      else setQueueError(e.message || "予約に失敗しました。");
      forgetUploadedLoraIfGone(e.message);
    } finally {
      setReserving((n) => n - 1);
    }
  };

  // 始まる前の予約を全部取り消す（全額返金）。始まったものは完走する。
  const handleCancelQueue = async () => {
    if (!user || reservedIds.length === 0) return;
    setQueueError(null);
    try {
      const r = await cancelStudioQueue("director", reservedIds);
      if (r.remainingCredits != null) broadcastCreditsUpdate(user.id, r.remainingCredits);
      trackedRef.current = trackedRef.current.filter((t) => !r.cancelled.includes(t.id));
      saveFormState(RESERVED_KEY, { items: trackedRef.current });
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : "予約の取り消しに失敗しました。");
    }
    void advanceAndFollow(false);
  };

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
            const videoUrl = next.videoUrl;
            if (videoUrl && takeAutoDownload(jobId)) {
              runAutoDownload("DirectorStudioTab", async () =>
                downloadDirectorVideo((await pollDirectorJob(jobId)).videoUrl ?? videoUrl, directorFilename(next.seed)),
              );
            }
            // 改めて生成したジョブが完了したら、前の「今回の生成」を消して
            // このジョブ 1 件から始める（確認時点では消さない）。
            if (freshJobIdRef.current === jobId) {
              freshJobIdRef.current = null;
              commitSession(sessionJobsRef.current.filter((e) => e.id === jobId));
            }
            // 予約の次の 1 件へ（起動はサーバー。普段は DB トリガーが先に起動している）。
            void advanceAndFollow(true);
            return;
          }
          if (next.status === "failed") {
            setPhase("error");
            setErrorMessage(next.errorMessage || "生成に失敗しました。");
            // 予約はサーバーが続けて起動する（失敗の表示は残すので画面は切り替えない）。
            void advanceAndFollow(false);
            return;
          }
          sawInProgress = true;
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof DirectorJobNotFoundError) {
            // 一時的な通信エラーと違いリトライしても直らない。すぐ諦めて案内し、古い参照は消す（CLAUDE.md §6-2）。
            setPhase("error");
            setErrorMessage("このジョブの記録が見つかりませんでした。お手数ですが新しく生成してください。");
            saveFormState(JOB_KEY, { jobId: "" });
            return;
          }
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
  }, [jobId, markGpuWarm, advanceAndFollow, commitSession]);

  const totalDurationS = useAudio && audioBreakdown
    ? audioBreakdown.totalDurationS
    : uiMode === "prompt"
      ? promptBreakdown.totalDurationS
      : uiMode === "advanced"
        ? conceptBreakdown.totalDurationS
        : directorTotalDurationS(scenes);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />
      <RestrictedChoiceModal
        open={restrictedRetry != null}
        surcharge={unrestrictedSurcharge}
        onCancel={() => setRestrictedRetry(null)}
        onUnlock={() => {
          const r = restrictedRetry;
          setRestrictedRetry(null);
          if (!r) return;
          const s = withEngine(r.snapshot, "unrestricted");
          if (r.opts.queue) void reserveSnapshot(s);
          else void runGenerate(s, { priority: r.opts.priority, continuation: r.opts.continuation });
        }}
      />
      <QueueChoiceModal
        open={queueChoiceOpen}
        surcharge={directorPriorityParallelSurcharge(knobs, cost)}
        total={cost + directorPriorityParallelSurcharge(knobs, cost)}
        onCancel={() => setQueueChoiceOpen(false)}
        onQueue={() => void handleQueueWait()}
        queueCost={cost}
        onParallel={handleQueueParallel}
      />

      {/* ── 左: 入力（参照画像 + タイムライン） ─────────────────────── */}
      <div className="flex flex-col gap-5 rounded-2xl border-gradient bg-surface/40 p-5">
        {handoffNotice && (
          <p className="flex items-start justify-between gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-[11px] leading-relaxed text-foreground">
            <span>{handoffNotice}</span>
            <button type="button" onClick={() => setHandoffNotice(null)} className="shrink-0 text-muted hover:text-foreground" aria-label="閉じる">
              <X size={12} />
            </button>
          </p>
        )}
        <ImageDropzone
          file={image}
          previewUrl={imagePreview}
          onFileSelected={setImage}
          onClear={() => setImage(null)}
          badge={referenceMode === "reference" ? "Picture 1" : undefined}
        />
        <p className="-mt-3 text-[11px] leading-relaxed text-muted">
          入れた画像の見た目（人物・絵柄・服装）のまま動かす機能です。アニメを実写にする・別人に変えるなど、見た目を大きく変える指示は苦手で、途中で崩れることがあります。
          見た目を変えたいときは、先に画像を作り直してから入れてください。
        </p>

        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">画像の使い方</p>
          <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-1">
            {(
              [
                { id: "first_frame", label: "最初の場面にする", sub: "画像から動き出す" },
                { id: "reference", label: "顔写真として使う", sub: "構図は自由・長い動画向き" },
              ] as const
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setReferenceMode(o.id)}
                className={`flex flex-1 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium leading-tight transition-colors ${
                  referenceMode === o.id ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
                }`}
              >
                <span>{o.label}</span>
                <span className="text-[10px] font-normal opacity-70">{o.sub}</span>
              </button>
            ))}
          </div>
          {referenceMode === "reference" && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <label className="text-xs text-muted">画面の縦横</label>
              <select
                value={aspect}
                onChange={(e) => setAspect(e.target.value as DirectorAspectId)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
              >
                {DIRECTOR_ASPECTS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {referenceMode === "reference" && (
            <div className="mt-3">
              <RefPhotoPicker
                value={refs}
                onChange={setRefs}
                help={
                  <>
                    写真ごとに使い方を選べます。「同じ人物」は角度・表情の違う写真（顔のアップ、横顔、口を開けて笑っている顔など）を足すほど、本人らしさと細部が保たれ、歌うときの口もよく動きます。
                    「持ち物」は道具や小物をそのままの形で持たせ、「場所」はその景色の中で撮り、「画風」は絵柄や色づかいを合わせます。
                    場所の写真は動画の縦横に合わせて中央を切り抜きます。1 枚足すごとに料金が少し上がります（生成に少し時間がかかるため）。
                  </>
                }
              />

              <p className="mb-1.5 mt-4 text-[11px] font-medium text-muted">
                手本の動画（任意・{DIRECTOR_REF_VIDEO_MIN_S}〜{DIRECTOR_REF_VIDEO_MAX_S} 秒）
              </p>
              <input
                ref={refVideoInputRef}
                type="file"
                accept="video/*,.mp4,.mov,.webm,.m4v"
                className="hidden"
                onChange={(e) => {
                  void handleRefVideoSelected(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {refVideo ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2">
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {refVideo.file.name}
                      <span className="ml-2 text-xs text-muted">約{Math.ceil(refVideo.durationS)}秒</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setRefVideo(null)}
                      className="shrink-0 text-muted transition-colors hover:text-red-400"
                      aria-label="手本の動画を外す"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-1">
                    {DIRECTOR_REF_VIDEO_ROLES.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setRefVideoRole(o.id)}
                        className={`flex flex-1 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium leading-tight transition-colors ${
                          refVideoRole === o.id ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
                        }`}
                      >
                        <span>{o.label}</span>
                        <span className="text-[10px] font-normal opacity-70">{o.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => refVideoInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void handleRefVideoSelected(e.dataTransfer.files?.[0]);
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-sm text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
                >
                  <Plus size={14} />
                  動画を選ぶ・ドロップ
                </button>
              )}
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                身ぶりや踊り、カメラの動きを手本の動画から写します。顔や服は写真のまま変わりません。
                手本の背景が動画に混ざることがあるので、背景が単純な動画がおすすめです。
                手本が長いほど生成に時間がかかり、料金も上がります（20 秒の動画に 10 秒の手本で約 2 倍）。
              </p>

              {!audio && (
                <>
                  <p className="mb-1.5 mt-4 text-[11px] font-medium text-muted">声の手本（任意・数秒）</p>
                  <input
                    ref={refVoiceInputRef}
                    type="file"
                    accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"
                    className="hidden"
                    onChange={(e) => {
                      void handleRefVoiceSelected(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  {refVoice ? (
                    <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2">
                      <span className="min-w-0 truncate text-sm text-foreground">{refVoice.name}</span>
                      <button
                        type="button"
                        onClick={() => setRefVoice(null)}
                        className="shrink-0 text-muted transition-colors hover:text-red-400"
                        aria-label="声の手本を外す"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => refVoiceInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        void handleRefVoiceSelected(e.dataTransfer.files?.[0]);
                      }}
                      className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-sm text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
                    >
                      <Plus size={14} />
                      声の音声を選ぶ・ドロップ（{DIRECTOR_REF_VOICE_MAX_S}秒まで）
                    </button>
                  )}
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    セリフをしゃべるとき、この声に寄せます。話し声だけが入った数秒の音声がおすすめです。
                  </p>
                </>
              )}
              {refMediaError && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-red-400">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {refMediaError}
                </p>
              )}
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            {referenceMode === "reference"
              ? "画像の人物の顔を手がかりに、場所や構図は文章どおりに作ります。顔がはっきり写った写真がおすすめです。長い動画でも顔が崩れにくくなります。"
              : "画像がそのまま動画の 1 枚目になり、そこから動き出します。画像と違う場所や服を文章に書くと、最初の一瞬で場面が切り替わります（そうしたいときは「顔写真として使う」へ）。"}
          </p>
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted">
            <Music size={12} />
            音声（任意・歌やセリフ）
          </p>
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"
            className="hidden"
            onChange={(e) => {
              void handleAudioSelected(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {audio ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2">
              <span className="min-w-0 truncate text-sm text-foreground">
                {audio.file.name}
                <span className="ml-2 text-xs text-muted">約{Math.ceil(audio.durationS)}秒</span>
              </span>
              <button
                type="button"
                onClick={() => setAudio(null)}
                className="shrink-0 text-muted transition-colors hover:text-red-400"
                aria-label="音声を外す"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => audioInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setAudioDragging(true);
              }}
              onDragLeave={() => setAudioDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setAudioDragging(false);
                void handleAudioSelected(e.dataTransfer.files?.[0]);
              }}
              className={`flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-2.5 text-sm transition-colors ${
                audioDragging
                  ? "border-neon-pink/60 bg-neon-pink/5 text-foreground"
                  : "border-border text-muted hover:border-neon-violet/40 hover:text-foreground"
              }`}
            >
              <Plus size={14} />
              音声ファイルを選ぶ・ドロップ（{DIRECTOR_MAX_AUDIO_SECONDS}秒まで）
            </button>
          )}
          {audioError && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-red-400">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              {audioError}
            </p>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            入れた音声をそのまま使い、口の動きを合わせます。動画の長さは音声の長さになります（高速モードでもこの音声が入ります）。
            歌の動画を作るときは「顔写真として使う」がおすすめです。
          </p>
        </div>

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
              onClick={() => setUiMode("advanced")}
              className={`flex flex-1 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                uiMode === "advanced" ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              <span>おまかせ</span>
              <span className="text-[10px] font-normal opacity-70">初心者におすすめ</span>
            </button>
            <button
              type="button"
              onClick={() => setUiMode("scenes")}
              className={`flex flex-1 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                uiMode === "scenes" ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              <span>シーンを組む</span>
              <span className="text-[10px] font-normal opacity-70">場面ごとに指定</span>
            </button>
            <button
              type="button"
              onClick={() => setUiMode("prompt")}
              className={`flex flex-1 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                uiMode === "prompt" ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              <span>直接書く</span>
              <span className="text-[10px] font-normal opacity-70">上級者向け</span>
            </button>
          </div>
        }

        {uiMode === "prompt" ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted">
                <Pencil size={12} />
                直接書く（上級者向け）
              </p>
              <button
                type="button"
                onClick={exitPromptMode}
                className="flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-foreground"
              >
                <Undo2 size={12} />
                おまかせに戻る
              </button>
            </div>
            {adjustBase && (
              <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-[11px] leading-relaxed text-foreground">
                <span>
                  元の動画と同じシード・同じ参照画像で作り直します（画像の入れ直しは不要）。
                  セリフの一言や光の加減など、小さな変更に向いています。カメラの向きや動きを変えると、別の動画になります。
                  元の言い回しを変えたくないときは、下の切り替えで英語の原文を直してください（日本語のまま直すと、全文が訳し直されて言い回しも変わります）。
                </span>
                <button
                  type="button"
                  onClick={() => setAdjustBase(null)}
                  className="shrink-0 text-muted underline transition-colors hover:text-foreground"
                >
                  解除
                </button>
              </div>
            )}
            {promptEnglish && (
              <PromptLanguageSwitch ja={promptJa} en={promptEnglish} draft={promptDraft} onPick={setPromptDraft} />
            )}
            <textarea
              ref={promptEditorRef}
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={8}
              placeholder="英語・日本語どちらでも入力できます（日本語は送信時に自動で英訳されます）"
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground placeholder:text-muted"
            />

            {useAudio ? (
              <p className="mt-3 text-xs text-muted">尺: 音声に合わせて約{totalDurationS}秒</p>
            ) : (
              <div className="mt-3 flex items-center justify-between gap-3">
                <label className="text-xs text-muted">尺</label>
                <select
                  value={promptDraftDurationS}
                  onChange={(e) => setPromptDraftDurationS(Number(e.target.value))}
                  className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                >
                  {/* 調整で入ったとき、元の動画の尺（シーンモードの 5 秒など）も選べるようにする。 */}
                  {[
                    ...new Set([
                      promptDraftDurationS,
                      ...Array.from(
                        { length: Math.floor(DIRECTOR_MAX_TOTAL_SECONDS / DIRECTOR_SECONDS_PER_SCENE) },
                        (_, i) => (i + 1) * DIRECTOR_SECONDS_PER_SCENE,
                      ),
                    ]),
                  ].sort((a, b) => a - b).map((s) => (
                    <option key={s} value={s}>
                      約{s}秒
                    </option>
                  ))}
                </select>
              </div>
            )}
            <HelpNote
              id="director.prompt" title="書き方のコツ（セリフ・日本語）"
              className="mt-2"
              textClass="text-[11px] text-muted"
              icon={<Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />}
              summary="ここに書いた文章がそのまま動画の指示になります。思いつきを書くだけなら Advanced（要点から台本）の方が向いています。"
            >
              シーンの自動合成をせず、書いた文章をそのまま使います（日本語で書いた部分は送信前に英訳されます）。
              「誰が・どう動き・カメラがどう動くか」まで書いてください。一言だけだと、長い動画では途中で人物が崩れることがあります
              （参照画像の人物のまま保つ指示が無いときは、自動で先頭に足します）。
              セリフを話させたい部分は「」で囲むと、そこだけ日本語のまま音声・リップシンクに反映されます。
            </HelpNote>
          </div>
        ) : uiMode === "advanced" ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted">
                <Sparkles size={12} />
                おまかせ — 要点を書くだけで、AI が台本にします
              </p>
            </div>
            <textarea
              value={conceptText}
              onChange={(e) => setConceptText(e.target.value.slice(0, DIRECTOR_SCENE_TEXT_MAX_LENGTH))}
              rows={4}
              placeholder={"やりたいことを一言や箇条書きで（200 字まで）。例:\n・雨の夜の路地裏、ネオン\n・こちらに気づいて振り向き、少し笑う\n・「やっと来たね」と言う"}
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground placeholder:text-muted"
            />
            {useAudio ? (
              <p className="mt-3 text-xs text-muted">尺: 音声に合わせて約{totalDurationS}秒</p>
            ) : (
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
            )}
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
              <Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />
              細かく書かなくて大丈夫です。AI が参照画像を見たうえで、場面の流れ・動き・カメラ・光・環境音まで台本に書き起こします。
              セリフは「」で書いたものだけが使われます（AI が勝手に足すことはありません）。台本を書く分、追加でクレジットがかかります。
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest text-muted">
                <Clapperboard size={12} />
                タイムライン（シーン）
              </p>
              <span className="text-[11px] text-muted">
                {useAudio ? `音声に合わせて 約${totalDurationS}秒（シーンの秒数は流れの目安）` : `合計 約${totalDurationS}秒`}
              </span>
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
                  {!useAudio && (
                    <input
                      type="text"
                      value={scene.dialogue ?? ""}
                      onChange={(e) =>
                        updateScene(i, { dialogue: e.target.value.slice(0, DIRECTOR_DIALOGUE_MAX_LENGTH) || undefined })
                      }
                      placeholder="セリフ（任意・リップシンク対応。例: こんにちは）"
                      className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted"
                    />
                  )}
                  {i > 0 && !useAudio && (
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

            {!useAudio && (
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
            )}

            <HelpNote
              id="director.scenes" title="シーンのつながり方"
              className="mt-2"
              textClass="text-[11px] text-muted"
              icon={<Sparkles size={12} className="mt-0.5 shrink-0 text-neon-violet" />}
              summary={`各シーンはAIが1本の連続した映像にまとめます（合計最大${DIRECTOR_MAX_TOTAL_SECONDS}秒）。`}
            >
              上から順番に展開されますが、厳密な秒数通りに切り替わる保証はありません。秒数は合計尺・消費クレジットの計算に使われます。
            </HelpNote>
          </div>
        )}
      </div>

      {/* ── 右: アクション / 結果 ───────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-border bg-background p-4">
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">画質モード</p>
          {(() => {
            const modeInfo = CINEMATIC_MODE_BY_ID[qualityMode === "quality" ? "vdnQuality" : "vdnFast"];
            const shape = directorAspectDims(media.referenceMode ?? "first_frame", media.aspect ?? "image", imageDims);
            const dims = cinematicSafeDimensions(
              shape.width,
              shape.height,
              cinematicMegapixelsForDuration(modeInfo, totalDurationS),
            );
            return (
              <p className="mb-2 text-[11px] text-muted">
                出力解像度:{" "}
                <span className="font-mono text-foreground">
                  {dims.width}×{dims.height}px
                </span>
                {referenceMode === "reference" && aspect !== "image"
                  ? ""
                  : imageDims
                    ? "（参照画像の縦横比に合わせて自動決定）"
                    : "（参照画像の縦横比に合わせて変わります）"}
                {totalDurationS > 34 ? "（長い動画は解像度を下げて作ります）" : ""}
                ・24fps・さらに高解像度にしたい場合は生成後に「4K 動画超解像」へ
              </p>
            );
          })()}
          <div className="grid grid-cols-2 gap-2">
            {(["fast", "quality"] as const).map((m) => {
              const modeInfo = CINEMATIC_MODE_BY_ID[m === "quality" ? "vdnQuality" : "vdnFast"];
              const selected = qualityMode === m;
              return (
                <button
                  key={m}
                  type="button"
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

        {loraUiEnabled && (
        <div className="rounded-xl border border-border bg-background p-4">
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">
            LoRA（任意）
            {/* 一般には閉じていて admin にだけ出ている（featureFlags.DIRECTOR_LORA_ENABLED）ことが分かるように。 */}
            {!DIRECTOR_LORA_ENABLED && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-px align-middle font-mono text-[9px] font-semibold normal-case tracking-normal text-amber-300">admin</span>}
          </p>
          <p className="-mt-1 mb-2 text-[11px] leading-relaxed text-muted">
            使えるのは MiniMax H3 用の LoRA だけです（LoRA Studio の「Minimax H3」で学習したもの、または H3 用に作られたファイル）。
            「顔写真として使う」と組み合わせると、本人らしさが一段上がります。
          </p>
          <div className={`grid gap-1.5 ${trainedLora ? "grid-cols-3" : "grid-cols-2"}`}>
            <button
              type="button"
              onClick={() => selectLoraSource("none")}
              className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                loraSource === "none" ? "bg-neon-violet/15 text-foreground" : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              なし
            </button>
            {trainedLora && (
              <button
                type="button"
                onClick={() => selectLoraSource("trained")}
                className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                  loraSource === "trained" ? "bg-neon-violet/15 text-foreground" : "bg-surface text-muted hover:text-foreground"
                }`}
              >
                LoRA Studio から
              </button>
            )}
            <button
              type="button"
              onClick={() => selectLoraSource("upload")}
              className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                loraSource === "upload" ? "bg-neon-violet/15 text-foreground" : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              アップロード
            </button>
          </div>

          {loraSource === "trained" && trainedLora && (
            <>
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
                  <Check size={12} className="shrink-0 text-emerald-400" />
                  <span className="truncate font-mono">{trainedLora.label || "LoRA Studio の LoRA"}</span>
                </span>
                <button
                  type="button"
                  onClick={removeTrainedLora}
                  className="shrink-0 text-[11px] text-muted transition-colors hover:text-foreground"
                >
                  外す
                </button>
              </div>
              <p className="mt-2 text-[11px] text-muted">
                LoRA Studio で作った LoRA を生成に適用します。次からは保存したファイルを「アップロード」で使えます。
              </p>
            </>
          )}

          {loraSource === "upload" && (
            <>
              <input
                type="file"
                accept=".safetensors"
                disabled={loraUploading}
                onChange={(e) => {
                  setLoraUploadFile(e.target.files?.[0] ?? null);
                  // 別のファイルを選び直したら、前回のアップロード済み状態は
                  // 無効——再アップロードが必要（handleUploadLoraが新しい
                  // Fileオブジェクトに対して改めて呼ばれる）。
                  setLoraUploadedKey(null);
                  setLoraUploadError(null);
                  setLoraUploadBytes(null);
                }}
                className="mt-2 w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-xs file:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
              {loraUploadFile && (
                <p className="mt-1.5 text-[11px] text-muted">
                  {loraUploadFile.name}（{(loraUploadFile.size / 1024 / 1024).toFixed(1)} MB）
                </p>
              )}
              {loraUploadFile && !loraUploadedKey && (
                <button
                  type="button"
                  onClick={() => void handleUploadLora()}
                  disabled={loraUploading}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-3 py-2 text-xs font-medium text-neon-violet transition-colors hover:bg-neon-violet/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loraUploading
                    ? loraUploadBytes && loraUploadBytes.total > 0
                      ? `アップロード中... ${Math.min(100, Math.round((loraUploadBytes.loaded / loraUploadBytes.total) * 100))}%`
                      : "アップロード中..."
                    : "このLoRAをアップロード"}
                </button>
              )}
              {loraUploading && (
                <>
                  {loraUploadBytes && loraUploadBytes.total > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface">
                      <div
                        className="h-full rounded-full bg-neon-violet transition-[width]"
                        style={{
                          width: `${Math.min(100, Math.max(0, (loraUploadBytes.loaded / loraUploadBytes.total) * 100))}%`,
                        }}
                      />
                    </div>
                  )}
                  {loraUploadBytes && (
                    <p className="mt-1 text-[11px] text-muted">
                      {(loraUploadBytes.loaded / 1024 / 1024).toFixed(1)} MB /{" "}
                      {(loraUploadBytes.total / 1024 / 1024).toFixed(1)} MB
                    </p>
                  )}
                  <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    アップロード中はブラウザを閉じないでください。途中で止まった場合は、もう一度「このLoRAをアップロード」を押してください。
                  </p>
                </>
              )}
              {loraUploadedKey && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-400">
                  <Check size={12} />
                  アップロード完了。このLoRAを使って生成できます。
                </p>
              )}
              {loraUploadError && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-red-400">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {loraUploadError}
                </p>
              )}
              <p className="mt-2 text-[11px] text-muted">
                外部で用意した LoRA（.safetensors）を持ち込んで適用します。先にアップロードを完了させてから生成してください。
                アップロードした LoRA はこのタブを閉じると消えます（開いたままでも 1 日たつと消えます）。
              </p>
            </>
          )}

          {loraSource !== "none" && (
            <div className="mt-3">
              <label htmlFor="director-lora-trigger" className="text-[11px] font-medium text-foreground">
                トリガーワード
              </label>
              <input
                id="director-lora-trigger"
                type="text"
                value={loraTrigger}
                maxLength={120}
                onChange={(e) => setLoraTrigger(e.target.value)}
                placeholder="例: hinata（複数人はカンマで区切る）"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted/60"
              />
              <p className="mt-1 text-[11px] text-muted">
                指示文に入っていなければ、先頭に自動で足します。顔などの特徴はトリガーワードに覚えさせているので、無いと別人が出ます。
              </p>
            </div>
          )}
        </div>
        )}

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

          {uiMode === "scenes" && (
            <div className="mt-3">
              <UnrestrictedToggle checked={unrestricted} onChange={setUnrestricted} surcharge={unrestrictedSurcharge} />
            </div>
          )}
          {!user ? (
            <button
              type="button"
              onClick={() => setLoginOpen(true)}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-background transition-all hover:opacity-90"
            >
              <LogIn size={16} />
              ログインして生成
            </button>
          ) : (
            <button
              type="button"
              onClick={chargeFirst ? () => setChargeOpen(true) : handleRun}
              disabled={!canRun && !chargeFirst}
              className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${
                chargeFirst ? "bg-amber-600/80 text-white" : "bg-gradient-to-r from-neon-pink to-neon-violet text-background"
              }`}
            >
              {chargeFirst ? (
                <>
                  <Zap size={16} />
                  クレジットをチャージ
                </>
              ) : phase === "submitting" ? (
                "送信中..."
              ) : phase === "running" ? (
                <QueueNextButtonLabel
                  status={job?.status === "processing" ? `生成中 ${formatElapsedSeconds(elapsedMs)}` : "生成準備中（GPU 起動中）"}
                />
              ) : (
                "生成する"
              )}
            </button>
          )}
          <GenerationCaveat />
          {user && (
            <div className="mt-2">
              <AutoDownloadToggle />
            </div>
          )}
          {!busy && gpuWarm && <WarmCountdownBanner remainingMs={gpuWarmMs} />}
          {busy && reservedIds.length === 0 && reserving === 0 && (
            // 2026-09-19: LoRAアップロードは生成ボタンを押す前の別操作
            // （handleUploadLora）に分離済みなので、ここに来る時点では
            // ジョブは既にサーバー側へ発行済み——ブラウザを閉じても継続する。
            <p className="mt-2 flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
              <Sparkles size={14} className="mt-0.5 shrink-0" />
              バックグラウンドで生成中です。もう一度ボタンを押すと、次の生成を予約できます。
            </p>
          )}
          {(reservedIds.length > 0 || reserving > 0) && (
            <div className="mt-2">
              <QueuedNextBanner count={reservedIds.length + reserving} serverSide onCancel={() => void handleCancelQueue()} />
            </div>
          )}
          {queueError && <p className="mt-2 text-xs text-red-400">{queueError}</p>}
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
          <div className="flex items-start gap-1.5 rounded-xl border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-[12px] leading-relaxed text-red-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="flex-1">{errorMessage}</span>
            {/* 閉じたら覚えているジョブも忘れる（失敗の表示はリロードでも残る作りなので、消す手段をここに置く）。 */}
            <button
              type="button"
              onClick={() => {
                setPhase("idle");
                setErrorMessage(null);
                setJob(null);
                setJobId(null);
                saveFormState(JOB_KEY, { jobId: "" });
              }}
              aria-label="エラーを閉じる"
              className="shrink-0 text-red-300/70 transition-colors hover:text-red-200"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {phase === "done" && job?.videoUrl && (
          <div className="rounded-xl border border-border bg-background p-3">
            <video
              src={job.videoUrl}
              controls
              className="w-full rounded-lg"
              onError={() => {
                if (videoReloadsRef.current >= 2) return;
                videoReloadsRef.current += 1;
                setTimeout(() => void freshVideoUrl(), 1500);
              }}
            />
            <button
              type="button"
              onClick={async () => {
                const url = await freshVideoUrl();
                if (!url) return;
                downloadDirectorVideo(url, directorFilename(job.seed)).catch((err) => {
                  console.error("[DirectorStudioTab] download failed:", err);
                  setErrorMessage("ダウンロードに失敗しました。");
                });
              }}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-neon-violet/40"
            >
              <Download size={14} />
              ダウンロード
            </button>
            {job.regenerable && (
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={busy}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-neon-violet/40 disabled:opacity-50"
              >
                <RefreshCw size={14} />
                別パターンで作り直す（同じ台本・{regenCost}C）
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                const url = await freshVideoUrl();
                if (!url) return;
                requestStudioHandoff(
                  { kind: "video", url, filename: directorFilename(job.seed), source: "Cinematic Director" },
                  "upscale_video",
                );
              }}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-neon-pink/40 bg-neon-pink/10 px-4 py-2.5 text-sm font-medium text-neon-pink transition-colors hover:bg-neon-pink/20"
            >
              <Sparkles size={14} />
              この動画を 4K 動画超解像へ
            </button>
            <div className="mt-2 flex items-center justify-center gap-3 text-[11px] text-muted">
              {job.outWidth && job.outHeight && (
                <span>
                  <span className="font-mono text-foreground">
                    {job.outWidth}×{job.outHeight}px
                  </span>
                  {job.totalDurationS ? ` ・ ${job.totalDurationS}秒` : ""} ・ 24fps
                </span>
              )}
              {job.vramUsedGb != null && <VramBadge gb={job.vramUsedGb} />}
            </div>
          </div>
        )}

      {peekId && peekId !== jobId && (
        <PrevResultPanel
          key={peekId}
          kind="video"
          resolveUrl={async () => (await pollDirectorJob(peekId)).videoUrl}
          onDownload={async (url) => downloadDirectorVideo(url, directorFilename((await pollDirectorJob(peekId)).seed))}
          onClose={() => setPeekId(null)}
        />
      )}
        {user && sessionJobs.length > 1 && (
          <StudioSessionList entries={sessionJobs} currentId={jobId} busy={busy} onShow={handleShowSession} />
        )}
        <SessionResetConfirmModal
          open={sessionResetOpen}
          onCancel={() => {
            pendingFreshRef.current = null;
            setSessionResetOpen(false);
          }}
          onConfirm={() => {
            setSessionResetOpen(false);
            const snap = pendingFreshRef.current;
            pendingFreshRef.current = null;
            if (snap) void runGenerate(snap);
          }}
        />

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
                {phase !== "done"
                  ? "このプロンプトを編集して次を予約"
                  : job.regenerable
                    ? "この動画をもとに調整する（同じシード）"
                    : "このプロンプトを編集して再生成"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
