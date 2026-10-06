"use client";

// 🎵 曲づくり（2026-10-06）: 思いつき（または手書きの歌詞）から、歌入りの曲を 3〜10 本まとめて作って選ぶ。
// 当たり外れがあるのでまとめて出す（ホスト判断）。曲の一部（最長 68 秒＝Director の音声の上限）を切り出して Director へ渡せる。
// 曲まるごとの動画は不可: 1 番だけでも 100 秒前後あり、分割して作ってつなぐと区切りごとに顔・場所が変わり、5 分なら数千円になる（ホスト判断で見送り）。
// Studio タブの標準（CLAUDE.md §6）: リロードで消えない・見つからない専用エラー・VRAM バッジ・起動待ち表示・
// 実行中は順番待ち／並列・URL を使い回さない・完了したら自動保存。使うモデルの名前は出さない（§2）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Clapperboard, Download, LogIn, Music, Sparkles, X, Zap } from "lucide-react";
import { HelpNote } from "./HelpNote";
import { TopupActions } from "./TopupActions";
import {
  SONG_IDEA_MAX_LENGTH,
  SONG_LYRICS_MAX_LENGTH,
  SONG_MAX_COUNT,
  SONG_MIN_COUNT,
  SONG_PARTS,
  clampSongParts,
  songPartsFromLyrics,
  type SongParts,
  SONG_STYLE_MAX_LENGTH,
  SONG_VOICES,
  songCredits,
  songPriorityParallelSurcharge,
  type SongVoiceId,
} from "@/lib/songPricing";
import { downloadSong, pollSongJob, SongJobNotFoundError, startSongJob, type SongApiError, type SongJobStatus } from "@/lib/songApi";
import { usePricingKnobs } from "@/hooks/usePricingKnobs";
import { loadFormState, saveFormState } from "@/lib/studioFormPersistence";
import { VramBadge } from "@/components/studio/VramBadge";
import AutoDownloadToggle from "@/components/studio/AutoDownloadToggle";
import GenerationCaveat from "@/components/studio/GenerationCaveat";
import { armAutoDownload, runAutoDownload, takeAutoDownload } from "@/lib/autoDownload";
import { advanceStudioQueue, cancelStudioQueue } from "@/lib/studioQueue";
import { sendAudioToDirector } from "@/lib/studioHandoff";
import { clipToWav } from "@/lib/audioClip";
import { DIRECTOR_MAX_AUDIO_SECONDS } from "@/lib/directorPricing";
import { LoginModal } from "@/components/LoginModal";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { useProfileCredits, broadcastCreditsUpdate } from "@/hooks/useProfileCredits";
import { useElapsedTimer, formatElapsedSeconds } from "@/hooks/useElapsedTimer";
import { useLocalWarmCountdown } from "@/hooks/useLocalWarmCountdown";
import { QueueChoiceModal, QueuedNextBanner, QueueNextButtonLabel, WarmCountdownBanner } from "@/components/studio/QueueChoiceModal";

type Phase = "idle" | "submitting" | "running" | "done" | "error";
type Mode = "idea" | "lyrics";

const JOB_KEY = "song-active-job";
const RESERVED_KEY = "song-reserved-jobs";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_CONSECUTIVE_ERRORS = 8;
const COUNTS = Array.from({ length: SONG_MAX_COUNT - SONG_MIN_COUNT + 1 }, (_, i) => SONG_MIN_COUNT + i);

type Snapshot = { mode: Mode; idea: string; lyrics: string; style: string; voice: SongVoiceId; count: number; parts: SongParts };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 保存するファイル名。シードが分かれば入れる（後から同じ声で作れるか試すとき辿れるように、2026-10-06）。 */
function songFilename(jobId: string, i: number, seed?: number | null): string {
  return `ull_song_${jobId.slice(0, 8)}_${i + 1}${seed ? `_s${seed}` : ""}.mp3`;
}

function InsufficientCreditsModal({ open, onClose, credits, cost }: { open: boolean; onClose: () => void; credits: number | null; cost: number }) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm" onClick={onClose}>
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

export function SongStudioTab() {
  const { user } = useSupabaseUser();
  const { credits, loading: creditsLoading } = useProfileCredits(user);
  const { knobs } = usePricingKnobs();
  const [loginOpen, setLoginOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [queueChoiceOpen, setQueueChoiceOpen] = useState(false);

  // --- 入力 ---
  const [mode, setMode] = useState<Mode>("idea");
  const [idea, setIdea] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [style, setStyle] = useState("");
  const [voice, setVoice] = useState<SongVoiceId>("female");
  const [count, setCount] = useState<number>(SONG_MIN_COUNT);
  // 長さ（何番まで）。手書きの歌詞は行数で決まる（サーバーと同じ関数）。
  const [partsChoice, setPartsChoice] = useState<SongParts>(1);
  const parts: SongParts = mode === "lyrics" ? songPartsFromLyrics(lyrics) : partsChoice;
  const partInfo = SONG_PARTS.find((p) => p.id === parts) ?? SONG_PARTS[0];
  const cost = songCredits(count, parts, knobs);
  // 待ち時間の目安（作り直しの見込み込み・起動 1〜2 分は別）。
  const estMinutes = Math.max(1, Math.round(partInfo.minutesPerSong * count));
  const insufficientCredits = Boolean(user) && !creditsLoading && (credits ?? 0) < cost;
  const lyricLines = useMemo(
    () => lyrics.split("\n").filter((l) => l.trim() && !l.trim().startsWith("[")).length,
    [lyrics],
  );

  // --- ジョブ ---
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<string | null>(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null);
  const [job, setJob] = useState<SongJobStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = phase === "submitting" || phase === "running";
  const elapsedMs = useElapsedTimer(phase === "running" && job?.status === "processing");
  const { isWarm: gpuWarm, remainingMs: gpuWarmMs, markWarm: markGpuWarm } = useLocalWarmCountdown(30);

  const trackedRef = useRef<string[]>(loadFormState<{ ids: string[] }>(RESERVED_KEY)?.ids ?? []);
  const [reservedIds, setReservedIds] = useState<string[]>([]);
  const [reserving, setReserving] = useState(0);
  const [queueError, setQueueError] = useState<string | null>(null);

  const buildSnapshot = (): Snapshot | null => {
    if (mode === "idea" && !idea.trim()) {
      setPhase("error");
      setErrorMessage("どんな曲にしたいかを書いてください。");
      return null;
    }
    if (mode === "lyrics" && !lyrics.trim()) {
      setPhase("error");
      setErrorMessage("歌詞を入れてください。");
      return null;
    }
    return { mode, idea: idea.trim(), lyrics: lyrics.trim(), style: style.trim(), voice, count, parts };
  };

  const start = useCallback(
    (s: Snapshot, opts: { priority?: boolean; queue?: boolean } = {}) =>
      startSongJob({
        mode: s.mode,
        idea: s.mode === "idea" ? s.idea : undefined,
        lyrics: s.mode === "lyrics" ? s.lyrics : undefined,
        style: s.style || undefined,
        voice: s.voice,
        count: s.count,
        parts: s.parts,
        ...opts,
      }),
    [],
  );

  const handleStartError = (err: unknown) => {
    const e = err as SongApiError;
    if (user && typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
    setPhase("error");
    setErrorMessage(e.message || "曲づくりの開始に失敗しました。");
    setRefused(e.code === "song_refused");
    if (e.message?.includes("クレジット")) setChargeOpen(true);
  };

  const runGenerate = async (s: Snapshot, opts: { priority?: boolean } = {}) => {
    if (!user) return;
    setPhase("submitting");
    setErrorMessage(null);
    setRefused(false);
    setActionError(null);
    setJob(null);
    try {
      const res = await start(s, opts);
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      armAutoDownload(res.jobId);
      setJobId(res.jobId);
      setPhase("running");
    } catch (err) {
      handleStartError(err);
    }
  };

  const handleRun = () => {
    if (!user) return setLoginOpen(true);
    const s = buildSnapshot();
    if (!s) return;
    if (busy) return setQueueChoiceOpen(true);
    if (insufficientCredits) return setChargeOpen(true);
    void runGenerate(s);
  };

  const followJob = useCallback((id: string) => {
    trackedRef.current = trackedRef.current.filter((x) => x !== id);
    saveFormState(RESERVED_KEY, { ids: trackedRef.current });
    setErrorMessage(null);
    setJob(null);
    setJobId(id);
    setPhase("running");
  }, []);

  const advanceAndFollow = useCallback(
    async (follow: boolean) => {
      const q = await advanceStudioQueue("song");
      if (!q) return;
      setReservedIds(q.reserved.filter((id) => trackedRef.current.includes(id)));
      if (!follow) return;
      const moved = trackedRef.current.filter((id) => !q.reserved.includes(id));
      const next = q.started && moved.includes(q.started) ? q.started : (moved[0] ?? null);
      if (next) followJob(next);
    },
    [followJob],
  );

  const resumedJobId = useMemo(() => loadFormState<{ jobId: string }>(JOB_KEY)?.jobId || null, []);
  useEffect(() => {
    if (!user) return;
    queueMicrotask(() => void advanceAndFollow(!resumedJobId));
  }, [user, resumedJobId, advanceAndFollow]);

  const reserve = async (s: Snapshot) => {
    if (!user) return;
    setQueueError(null);
    setReserving((n) => n + 1);
    try {
      const res = await start(s, { queue: true });
      broadcastCreditsUpdate(user.id, res.remainingCredits);
      armAutoDownload(res.jobId);
      trackedRef.current = [...trackedRef.current.filter((x) => x !== res.jobId), res.jobId];
      saveFormState(RESERVED_KEY, { ids: trackedRef.current });
      if (res.reserved) setReservedIds((prev) => (prev.includes(res.jobId) ? prev : [...prev, res.jobId]));
      else followJob(res.jobId);
    } catch (err) {
      const e = err as SongApiError;
      if (typeof e.remainingCredits === "number") broadcastCreditsUpdate(user.id, e.remainingCredits);
      setQueueError(e.message || "予約に失敗しました。");
    } finally {
      setReserving((n) => n - 1);
    }
  };

  const handleQueueWait = async () => {
    const s = buildSnapshot();
    if (!s || !user) return;
    setQueueChoiceOpen(false);
    if (insufficientCredits) return setChargeOpen(true);
    await reserve(s);
  };

  const handleQueueParallel = () => {
    const s = buildSnapshot();
    if (!s) return;
    setQueueChoiceOpen(false);
    if (!creditsLoading && (credits ?? 0) < cost + songPriorityParallelSurcharge(knobs, cost)) return setChargeOpen(true);
    void runGenerate(s, { priority: true });
  };

  const handleCancelQueue = async () => {
    if (!user || reservedIds.length === 0) return;
    setQueueError(null);
    try {
      const r = await cancelStudioQueue("song", reservedIds);
      if (r.remainingCredits != null) broadcastCreditsUpdate(user.id, r.remainingCredits);
      trackedRef.current = trackedRef.current.filter((x) => !r.cancelled.includes(x));
      saveFormState(RESERVED_KEY, { ids: trackedRef.current });
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : "予約の取り消しに失敗しました。");
    }
    void advanceAndFollow(false);
  };

  // --- ポーリング（完了しても job key は消さない、CLAUDE.md §6-1） ---
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let errorStreak = 0;
    let sawInProgress = false;
    saveFormState(JOB_KEY, { jobId });
    (async () => {
      while (!cancelled) {
        try {
          const next = await pollSongJob(jobId);
          if (cancelled) return;
          errorStreak = 0;
          setJob(next);
          if (next.status === "completed") {
            setPhase("done");
            if (sawInProgress) markGpuWarm();
            if (next.audioUrls.length && takeAutoDownload(jobId)) {
              runAutoDownload("SongStudioTab", async () => {
                // 署名は 15 分で切れるので保存する時点で取り直す（CLAUDE.md §6-11）。
                const fresh = await pollSongJob(jobId);
                for (let i = 0; i < fresh.audioUrls.length; i++)
                  await downloadSong(fresh.audioUrls[i], songFilename(jobId, i, fresh.seeds[i]));
              });
            }
            void advanceAndFollow(true);
            return;
          }
          if (next.status === "failed" || next.status === "cancelled" || next.status === "failed_timeout") {
            setPhase("error");
            setErrorMessage(next.errorMessage ? "曲を作れませんでした。クレジットは戻しています。" : "曲を作れませんでした。");
            void advanceAndFollow(false);
            return;
          }
          sawInProgress = sawInProgress || next.status === "processing";
          setPhase("running");
        } catch (err) {
          if (cancelled) return;
          if (err instanceof SongJobNotFoundError) {
            setPhase("error");
            setErrorMessage("このジョブの記録が見つかりませんでした。お手数ですが新しく作ってください。");
            saveFormState(JOB_KEY, { jobId: "" });
            return;
          }
          errorStreak += 1;
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
  }, [jobId, markGpuWarm, advanceAndFollow]);

  const refreshUrls = useCallback(async (): Promise<string[]> => {
    if (!jobId) return [];
    try {
      const next = await pollSongJob(jobId);
      setJob(next);
      return next.audioUrls;
    } catch {
      return [];
    }
  }, [jobId]);

  const handleDownload = async (i: number, format: "mp3" | "wav" = "mp3") => {
    if (!jobId) return;
    setActionError(null);
    let url: string | undefined;
    try {
      const next = await pollSongJob(jobId);
      setJob(next);
      url = format === "wav" ? next.audioWavUrls[i] : next.audioUrls[i];
    } catch {
      url = undefined;
    }
    if (!url) return setActionError("曲の取得に失敗しました。時間をおいてもう一度お試しください。");
    const name = songFilename(jobId, i, job?.seeds[i]);
    downloadSong(url, format === "wav" ? name.replace(/\.mp3$/, ".wav") : name).catch((err) => {
      console.error("[SongStudioTab] download failed:", err);
      setActionError("ダウンロードに失敗しました。");
    });
  };

  // 一部を切り出して Director へ（最長 68 秒）。範囲は曲ごとに選ぶ。
  const [clipFor, setClipFor] = useState<number | null>(null);
  const [clipStart, setClipStart] = useState(0);
  const [clipLen, setClipLen] = useState(30);
  const [clipping, setClipping] = useState(false);
  const handleToDirector = async (i: number) => {
    if (!jobId) return;
    setActionError(null);
    setClipping(true);
    try {
      const url = (await refreshUrls())[i];
      if (!url) throw new Error("no url");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Math.max(3, Math.min(DIRECTOR_MAX_AUDIO_SECONDS, clipLen));
      const { file } = await clipToWav(await res.blob(), Math.max(0, clipStart), len, songFilename(jobId, i, job?.seeds[i]).replace(".mp3", `_from${clipStart}s.wav`));
      sendAudioToDirector(file);
    } catch (err) {
      console.error("[SongStudioTab] handoff failed:", err);
      setActionError("Director へ渡せませんでした。もう一度お試しください。");
    } finally {
      setClipping(false);
    }
  };

  const reloadsRef = useRef<Record<number, number>>({});
  const canRun = (mode === "idea" ? idea.trim() : lyrics.trim()).length > 0 && phase !== "submitting";
  const chargeFirst = Boolean(user) && insufficientCredits && !busy;
  const audioUrls = job?.audioUrls ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      <InsufficientCreditsModal open={chargeOpen} onClose={() => setChargeOpen(false)} credits={credits} cost={cost} />
      <QueueChoiceModal
        open={queueChoiceOpen}
        surcharge={songPriorityParallelSurcharge(knobs, cost)}
        total={cost + songPriorityParallelSurcharge(knobs, cost)}
        queueCost={cost}
        onCancel={() => setQueueChoiceOpen(false)}
        onQueue={() => void handleQueueWait()}
        onParallel={handleQueueParallel}
      />

      {/* --- 入力 --- */}
      <div className="space-y-5 rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-1">
          {(
            [
              { id: "idea", label: "思いつきから", sub: "AI が歌詞を書く" },
              { id: "lyrics", label: "歌詞を書く", sub: "自分の歌詞で" },
            ] as const
          ).map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={`flex flex-1 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium leading-tight transition-colors ${
                mode === o.id ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              <span>{o.label}</span>
              <span className="text-[10px] font-normal opacity-70">{o.sub}</span>
            </button>
          ))}
        </div>

        {mode === "idea" ? (
          <div>
            <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">どんな曲？</p>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value.slice(0, SONG_IDEA_MAX_LENGTH))}
              rows={4}
              placeholder="例: 夕方の屋上でギターを弾きながら、明日の自分に向けて歌う前向きな曲"
              className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60"
            />
            <p className="mt-1 text-right text-[10px] text-muted">
              {idea.length} / {SONG_IDEA_MAX_LENGTH}
            </p>
            <p className="text-[11px] leading-relaxed text-muted">
              場面・気持ち・誰に向けた歌かを書くと、歌詞にしやすくなります。歌詞は選んだ長さに合わせて AI が書きます（1 番＝8 行）。
            </p>
          </div>
        ) : (
          <div>
            <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">歌詞</p>
            <textarea
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value.slice(0, SONG_LYRICS_MAX_LENGTH))}
              rows={10}
              placeholder={"[Verse]\nかいだんを かけあがって\nとびらを そっと あけたら\n…\n\n[Chorus]\nゆうやけの おくじょうで ならすよ\n…"}
              className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted/60"
            />
            <p className={`mt-1 text-right text-[10px] ${lyricLines > 0 && (lyricLines < 6 || lyricLines > 30) ? "text-amber-400" : "text-muted"}`}>
              {lyricLines} 行（{partInfo.label}）
            </p>
            <HelpNote
              id="song.lyrics"
              title="うまくいく歌詞の目安"
              summary="1 番は A メロ 4 行＋サビ 4 行が目安。1 行は短く（8〜12 音くらい）、[Verse]（A メロ）と [Chorus]（サビ）を分けると、まとまった曲になりやすいです。"
            >
              10 行までは 1 番だけ、20 行までは 2 番まで、それより多いと 3 番までの長さと料金になります。2 番以降の間に [Instrumental]（間奏）を入れるのがおすすめです。
              4 行だけだと短すぎて、曲の長さが余りやすくなります。読み間違えやすい漢字は自動でかなに直します。
              実在の歌手名や、既存の曲の歌詞は使わないでください。
            </HelpNote>
          </div>
        )}

        <div>
          <p className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">曲調（任意）</p>
          <input
            value={style}
            onChange={(e) => setStyle(e.target.value.slice(0, SONG_STYLE_MAX_LENGTH))}
            placeholder="例: 明るい J-POP、アコースティックギター、夕暮れ"
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted">声</label>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value as SongVoiceId)}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            >
              {SONG_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted">1 回で作る曲数</label>
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            >
              {COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n} 曲
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted">曲の長さ</label>
          {mode === "idea" ? (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-1">
              {SONG_PARTS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPartsChoice(clampSongParts(p.id))}
                  className={`flex flex-1 flex-col items-center justify-center rounded-lg px-2 py-1.5 text-xs font-medium leading-tight transition-colors ${
                    partsChoice === p.id ? "bg-neon-violet/15 text-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  <span>{p.label}</span>
                  <span className="text-[10px] font-normal opacity-70">{p.length}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground">
              {partInfo.label}（{partInfo.length}）<span className="ml-1 text-muted">— 歌詞の行数から決まります</span>
            </p>
          )}
        </div>
        <p className="-mt-2 text-[11px] leading-relaxed text-muted">
          同じ歌詞・曲調で、少しずつ違う曲をまとめて作るので、気に入った 1 曲を選べます。
          声が入らなかった曲や、歌詞を歌っていない曲（ハミングだけなど）は自動で検知し、規定回数まで自動で作り直します（その分は料金に含まれています）。
          長い曲ほど作り直しが増え、時間がかかります（{count} 曲で約 {estMinutes} 分〜。初回は GPU の起動に 1〜2 分）。
        </p>
      </div>

      {/* --- 実行と結果 --- */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 text-muted">
              <Music size={14} />
              曲づくり
            </span>
            <span className="font-mono font-medium text-neon-pink">{cost} Credits</span>
          </div>
          {!user ? (
            <button
              type="button"
              onClick={() => setLoginOpen(true)}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-background transition-all hover:opacity-90"
            >
              <LogIn size={16} />
              ログインして作る
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
                "歌詞を準備中..."
              ) : phase === "running" ? (
                <QueueNextButtonLabel
                  status={
                    job?.status === "processing"
                      ? `作曲中 ${job.progressMessage ?? ""} ${formatElapsedSeconds(elapsedMs)}`
                      : "生成準備中（GPU 起動中）"
                  }
                />
              ) : (
                `${count} 曲つくる`
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
            <p className="mt-2 flex items-start gap-2 rounded-lg border border-neon-violet/30 bg-neon-violet/10 px-3 py-2 text-xs leading-relaxed text-neon-violet">
              <Sparkles size={14} className="mt-0.5 shrink-0" />
              {job?.status === "processing"
                ? "バックグラウンドで作曲中です。画面を閉じても続きます。もう一度ボタンを押すと次を予約できます。"
                : "生成準備中…GPU を起動しています（初回は 1〜2 分）。画面を閉じても続きます。"}
            </p>
          )}
          {(reservedIds.length > 0 || reserving > 0) && (
            <div className="mt-2">
              <QueuedNextBanner count={reservedIds.length + reserving} serverSide onCancel={() => void handleCancelQueue()} />
            </div>
          )}
          {queueError && <p className="mt-2 text-xs text-red-400">{queueError}</p>}
        </div>

        {phase === "running" && (
          <div className="flex justify-center">
            <VramBadge gb={job?.vramUsedGb ?? null} />
          </div>
        )}

        {phase === "error" && errorMessage && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-3 py-2.5 text-[12px] leading-relaxed text-red-300">
            <p className="flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {errorMessage}
            </p>
            {refused && (
              <button
                type="button"
                onClick={() => {
                  setMode("lyrics");
                  setPhase("idle");
                  setErrorMessage(null);
                }}
                className="mt-2 rounded-lg border border-border bg-background px-3 py-1 text-[11px] text-foreground"
              >
                「歌詞を書く」に切り替える
              </button>
            )}
          </div>
        )}

        {phase === "done" && audioUrls.length > 0 && (
          <div className="space-y-3 rounded-xl border border-border bg-background p-3">
            {job?.title && <p className="text-sm font-semibold text-foreground">{job.title}</p>}
            {audioUrls.map((u, i) => (
              <div key={i} className="rounded-lg border border-border bg-surface p-2">
                <p className="mb-1 text-[11px] text-muted">{i + 1} 曲目</p>
                <audio
                  src={u}
                  controls
                  preload="none"
                  className="w-full"
                  onError={() => {
                    const n = reloadsRef.current[i] ?? 0;
                    if (n >= 2) return;
                    reloadsRef.current[i] = n + 1;
                    setTimeout(() => void refreshUrls(), 1500);
                  }}
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleDownload(i, "mp3")}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                  >
                    <Download size={12} />
                    MP3
                  </button>
                  {(job?.audioWavUrls.length ?? 0) > i && (
                    <button
                      type="button"
                      onClick={() => void handleDownload(i, "wav")}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                    >
                      <Download size={12} />
                      WAV
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setClipFor(clipFor === i ? null : i)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 text-[11px] text-foreground transition-colors hover:border-neon-violet/40"
                  >
                    <Clapperboard size={12} />
                    一部を動画の音声に
                  </button>
                </div>
                {clipFor === i && (
                  <div className="mt-2 space-y-2 rounded-lg border border-border bg-background p-2 text-[11px] text-muted">
                    <p>
                      歌う動画の音声は {DIRECTOR_MAX_AUDIO_SECONDS} 秒までです。使う範囲（サビなど）を選んで、Cinematic Director へ渡します。
                    </p>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1">
                        開始
                        <input
                          type="number"
                          min={0}
                          value={clipStart}
                          onChange={(e) => setClipStart(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                          className="w-16 rounded-md border border-border bg-surface px-1.5 py-0.5 text-foreground"
                        />
                        秒から
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="number"
                          min={3}
                          max={DIRECTOR_MAX_AUDIO_SECONDS}
                          value={clipLen}
                          onChange={(e) =>
                            setClipLen(Math.max(3, Math.min(DIRECTOR_MAX_AUDIO_SECONDS, Math.floor(Number(e.target.value) || 0))))
                          }
                          className="w-16 rounded-md border border-border bg-surface px-1.5 py-0.5 text-foreground"
                        />
                        秒間
                      </label>
                    </div>
                    <button
                      type="button"
                      disabled={clipping}
                      onClick={() => void handleToDirector(i)}
                      className="w-full rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1.5 text-[11px] font-semibold text-background disabled:opacity-50"
                    >
                      {clipping ? "切り出し中..." : "この範囲を Director へ渡す"}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {job?.lyrics && (
              <details className="rounded-lg border border-border bg-surface p-2 text-[12px] text-muted">
                <summary className="cursor-pointer text-foreground">歌詞を見る</summary>
                <pre className="mt-2 whitespace-pre-wrap font-sans leading-relaxed">{job.lyrics}</pre>
              </details>
            )}
            {job?.vramUsedGb != null && (
              <div className="flex justify-center">
                <VramBadge gb={job.vramUsedGb} />
              </div>
            )}
          </div>
        )}
        {actionError && <p className="text-xs text-red-400">{actionError}</p>}
      </div>
    </div>
  );
}
