"use client";

import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Download,
  Flame,
  Languages,
  Loader2,
  RotateCcw,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { translateCaption, translateCaptionsBatch } from "@/lib/loraTranslate";
import { buildDatasetZip, downloadBlob } from "@/lib/datasetZip";
import { ImageLightbox } from "@/components/studio/ImageLightbox";
import type { ResolvedCaptionMode } from "@/lib/loraCaptionSpec";

export type CurationPair = {
  id: string;
  file: File;
  url: string;
  name: string;
  // English caption / tag list — this is what actually goes to training.
  caption: string;
  // Japanese working copy (never sent as-is; round-tripped through "to_en").
  captionJa: string;
  excluded: boolean;
};

const inputCls =
  "w-full rounded-lg border border-border bg-background/70 px-3 py-2 text-xs text-foreground outline-none transition-colors focus:border-neon-violet/50 disabled:opacity-50";

function fmtMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function DatasetCurationUI({
  pairs,
  onChange,
  onConfirm,
  onCancel,
  requiredCredits,
  triggerWord,
  maxImages,
  maxTotalBytes,
  disabled = false,
  onRecaption,
  resolvedCaptionMode = "tags",
}: {
  pairs: CurationPair[];
  // A setState updater — every mutation is applied against the freshest state
  // so an exclude toggle can never clobber (or be clobbered by) an in-flight
  // translation landing on a different card.
  onChange: Dispatch<SetStateAction<CurationPair[]>>;
  onConfirm: () => void;
  onCancel: () => void;
  requiredCredits: number;
  // The trigger token — kept verbatim through translation (Gemini otherwise
  // transliterates it, e.g. yukipas -> yukipasu on the reverse pass).
  triggerWord: string;
  maxImages: number;
  maxTotalBytes: number;
  disabled?: boolean;
  // Re-run AI-vision captioning for the given cards; resolves to { id: {en,ja} }
  // for the ones that landed. Omitted -> the re-analyze affordances are hidden.
  // `forceOverwrite` re-analyses even cards that already have a caption.
  onRecaption?: (
    targets: { id: string; file: File; caption?: string; captionJa?: string }[],
    opts?: { forceOverwrite?: boolean },
  ) => Promise<Record<string, { en: string; ja: string }>>;
  // Caption FORMAT resolved for the selected base model — drives the format
  // mismatch warning and the confirm-dialog wording.
  resolvedCaptionMode?: ResolvedCaptionMode;
}) {
  // Per-card in-flight translation direction, keyed by pair id.
  const [busyId, setBusyId] = useState<Record<string, "ja" | "en" | undefined>>({});
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);
  // Pair ids with an AI re-analysis in flight.
  const [recappingIds, setRecappingIds] = useState<Set<string>>(() => new Set());
  // Index into `pairs` of the image open in the zoom lightbox (null = closed).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const lightboxItems = useMemo(
    () =>
      pairs.map((p) => ({
        id: p.id,
        url: p.url,
        name: p.name,
        caption: p.caption,
        captionJa: p.captionJa,
      })),
    [pairs],
  );

  const runRecaption = async (targets: CurationPair[], forceOverwrite = false) => {
    if (!onRecaption || targets.length === 0) return;
    const live = targets.filter((t) => !recappingIds.has(t.id));
    if (!live.length) return;
    setError(null);
    setRecappingIds((prev) => {
      const next = new Set(prev);
      live.forEach((t) => next.add(t.id));
      return next;
    });
    try {
      const out = await onRecaption(
        live.map((t) => ({ id: t.id, file: t.file, caption: t.caption, captionJa: t.captionJa })),
        { forceOverwrite },
      );
      const updates: Record<string, Partial<CurationPair>> = {};
      for (const t of live) {
        const r = out[t.id];
        if (r && (r.en.trim() || r.ja.trim())) {
          updates[t.id] = {
            caption: r.en.trim() || t.caption,
            captionJa: r.ja.trim() || t.captionJa,
          };
        }
      }
      if (Object.keys(updates).length) {
        onChange((prev) => prev.map((p) => (updates[p.id] ? { ...p, ...updates[p.id] } : p)));
      }
      const stillEmpty = live.filter((t) => !out[t.id]?.en.trim() && !out[t.id]?.ja.trim());
      if (stillEmpty.length) {
        setError(`${stillEmpty.length} 枚は再解析できませんでした（学習時に自動補完されます）。`);
      }
    } catch {
      setError("再解析に失敗しました。時間をおいて再試行してください。");
    } finally {
      setRecappingIds((prev) => {
        const next = new Set(prev);
        live.forEach((t) => next.delete(t.id));
        return next;
      });
    }
  };

  const uncaptioned = useMemo(
    () => pairs.filter((p) => !p.excluded && !p.caption.trim()),
    [pairs],
  );

  const captionModeLabel = (m: ResolvedCaptionMode) =>
    m === "dense" ? "Dense（自然言語散文）" : "Tags（カンマ区切りタグ）";

  // Format-mismatch guard: the base model resolves to Dense prose, but the
  // cards on screen are mostly comma-tag lists — a stale localStorage draft or
  // a Tags→Dense model switch left a chimera dataset. Excluded cards are not
  // counted. "Tag-like" means it genuinely reads as a Danbooru list: NO
  // sentence-ending punctuation AND either densely comma-separated (≥4
  // segments) or just a handful of words. A short prose sentence that ends in
  // "." is NOT a mismatch — the old "< 50 words" cutoff false-flagged every
  // faithfully back-translated Dense caption. Warn only when tag-like cards
  // are the majority.
  const formatMismatch = useMemo(() => {
    if (resolvedCaptionMode !== "dense") return false;
    const withCap = pairs.filter((p) => !p.excluded && p.caption.trim());
    if (withCap.length < 2) return false;
    const tagLike = withCap.filter((p) => {
      const c = p.caption.trim();
      const hasSentencePunct = /[.!?]["')\]]?(\s|$)/.test(c);
      const commaSegs = c.split(",").length - 1;
      const words = c.split(/\s+/).filter(Boolean).length;
      return !hasSentencePunct && (commaSegs >= 4 || words < 12);
    }).length;
    return tagLike > withCap.length / 2;
  }, [pairs, resolvedCaptionMode]);

  // Confirm, then re-analyse EVERY card in the current format (forceOverwrite).
  // Shared by the toolbar button and the mismatch banner's repair button.
  const forceRecaptionAll = () => {
    if (!onRecaption || pairs.length === 0) return;
    const ok = window.confirm(
      `現在の形式【${captionModeLabel(resolvedCaptionMode)}】で、すべてのカード（${pairs.length}件）の` +
        `キャプションを上書き再解析しますか？手動編集した内容はリセットされます。`,
    );
    if (!ok) return;
    void runRecaption(pairs, true);
  };

  const downloadDataset = async () => {
    setZipping(true);
    setError(null);
    try {
      const list = pairs.filter((p) => !p.excluded);
      const blob = await buildDatasetZip(
        list.map((p) => ({ file: p.file, caption: (p.caption || p.captionJa || "").trim() })),
      );
      downloadBlob(blob, `dataset_${list.length}img.zip`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ZIP の作成に失敗しました。");
    } finally {
      setZipping(false);
    }
  };

  const kept = useMemo(() => pairs.filter((p) => !p.excluded), [pairs]);
  const keptBytes = useMemo(() => kept.reduce((s, p) => s + p.file.size, 0), [kept]);
  const overCount = kept.length > maxImages;
  const overBytes = keptBytes > maxTotalBytes;
  const canConfirm = !disabled && kept.length >= 1 && !overCount && !overBytes && !bulk;

  const patch = (id: string, next: Partial<CurationPair>) =>
    onChange((prev) => prev.map((p) => (p.id === id ? { ...p, ...next } : p)));

  const patchMany = (updates: Record<string, Partial<CurationPair>>) => {
    if (Object.keys(updates).length === 0) return;
    onChange((prev) => prev.map((p) => (updates[p.id] ? { ...p, ...updates[p.id] } : p)));
  };

  // Protect the trigger token from the translator: peel a leading trigger
  // (with optional trailing comma, EN or JP) off before sending, and glue the
  // ORIGINAL trigger back on after.
  const trig = triggerWord.trim();
  const trigRe = trig ? new RegExp(`^\\s*${escapeRe(trig)}\\s*[,、]?\\s*`, "i") : null;
  const stripTrigger = (s: string) => (trigRe ? s.replace(trigRe, "") : s);
  // A leading token that IS the trigger, or a transliteration of it (Gemini
  // turns "yukipas" into "yukipasu" on the reverse pass).
  const looksLikeTrigger = (tok: string) => {
    const a = tok.trim().toLowerCase();
    const b = trig.toLowerCase();
    if (!a || !b) return false;
    return a === b || (a.startsWith(b) && a.length > b.length && a.length - b.length <= 2);
  };
  const withTrigger = (s: string) => {
    let body = s.trim();
    if (!trig) return body;
    const parts = body.split(/\s*[,、]\s*/);
    if (parts.length && looksLikeTrigger(parts[0])) {
      parts.shift();
      body = parts.join(", ").trim();
    }
    return body ? `${trig}, ${body}` : trig;
  };

  // One translation call with the trigger peeled off + re-attached. Returns
  // null when there's nothing (but the trigger) to translate.
  const translateProtected = async (text: string, dir: "ja" | "en"): Promise<string | null> => {
    const body = stripTrigger(text).trim();
    if (!body) return trig ? trig : null;
    const out = await translateCaption(body, dir === "ja" ? "to_ja" : "to_en", resolvedCaptionMode);
    return withTrigger(out);
  };

  const runTranslate = async (id: string, dir: "ja" | "en") => {
    const pair = pairs.find((p) => p.id === id);
    if (!pair) return;
    const src = dir === "ja" ? pair.caption : pair.captionJa;
    if (!src.trim()) return;
    setBusyId((b) => ({ ...b, [id]: dir }));
    setError(null);
    try {
      const out = await translateProtected(src, dir);
      if (out != null) patch(id, dir === "ja" ? { captionJa: out } : { caption: out });
    } catch (err) {
      setError(err instanceof Error ? err.message : "翻訳に失敗しました。");
    } finally {
      setBusyId((b) => ({ ...b, [id]: undefined }));
    }
  };

  // Batched bulk translate: chunk the targets, one Gemini call per chunk
  // (well under the 15 RPM free tier), trigger peeled off / re-attached per
  // item, all results applied via patchMany so a concurrent exclude is safe.
  const runBatch = async (dir: "ja" | "en", targets: CurationPair[]) => {
    if (!targets.length) return;
    setError(null);
    setBulk({ done: 0, total: targets.length });
    try {
      const CHUNK = 12;
      for (let i = 0; i < targets.length; i += CHUNK) {
        const chunk = targets.slice(i, i + CHUNK);
        const bodies = chunk.map((t) => stripTrigger(dir === "ja" ? t.caption : t.captionJa).trim());
        const sendIdx = bodies.map((b, k) => (b ? k : -1)).filter((k) => k >= 0);

        const outs = new Array<string>(chunk.length).fill("");
        if (sendIdx.length) {
          const res = await translateCaptionsBatch(
            sendIdx.map((k) => bodies[k]),
            dir === "ja" ? "to_ja" : "to_en",
            resolvedCaptionMode,
          );
          sendIdx.forEach((k, j) => {
            outs[k] = res[j] ?? "";
          });
        }

        const updates: Record<string, Partial<CurationPair>> = {};
        chunk.forEach((t, k) => {
          if (!bodies[k]) {
            // caption was only the trigger (or blank)
            if (trig) updates[t.id] = dir === "ja" ? { captionJa: trig } : { caption: trig };
            return;
          }
          if (!outs[k]) return; // this item failed to translate — leave it
          const val = withTrigger(outs[k]);
          updates[t.id] = dir === "ja" ? { captionJa: val } : { caption: val };
        });
        patchMany(updates);

        setBulk({ done: Math.min(i + CHUNK, targets.length), total: targets.length });
        if (i + CHUNK < targets.length) await new Promise((r) => setTimeout(r, 900));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "一括翻訳に失敗しました。");
    } finally {
      setBulk(null);
    }
  };

  const translateAllToJa = () =>
    runBatch(
      "ja",
      pairs.filter((p) => !p.excluded && p.caption.trim() && !p.captionJa.trim()),
    );
  const translateAllToEn = () =>
    runBatch(
      "en",
      pairs.filter((p) => !p.excluded && p.captionJa.trim()),
    );

  return (
    <div className="space-y-4 rounded-2xl border-gradient bg-surface/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
            <Check size={15} className="text-neon-violet" />
            データセットの確認・編集（キュレーション）
          </h3>
          <p className="mt-1 text-[11px] text-muted">
            不要な画像を除外し、キャプションを日本語で確認・修正できます。残った{" "}
            <span className="text-foreground">{kept.length}</span> / {pairs.length} 枚（
            {fmtMb(keptBytes)}）で学習します。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {bulk && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-neon-violet">
              <Loader2 size={12} className="animate-spin" />
              一括翻訳中… {bulk.done}/{bulk.total}
            </span>
          )}
          {onRecaption && uncaptioned.length > 0 && (
            <button
              type="button"
              onClick={() => void runRecaption(uncaptioned)}
              disabled={disabled || Boolean(bulk) || recappingIds.size > 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/60 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {recappingIds.size > 0 ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RotateCcw size={13} />
              )}
              🔄 未キャプション {uncaptioned.length} 枚を再解析
            </button>
          )}
          {onRecaption && pairs.length > 0 && (
            <button
              type="button"
              onClick={forceRecaptionAll}
              disabled={disabled || Boolean(bulk) || recappingIds.size > 0}
              title={`全カードを現在の形式【${captionModeLabel(resolvedCaptionMode)}】で上書き再解析します。`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neon-violet/50 bg-neon-violet/10 px-3 py-1.5 text-xs font-semibold text-neon-violet transition-colors hover:bg-neon-violet/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {recappingIds.size > 0 ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RotateCcw size={13} />
              )}
              🔄 全カードを現在の形式で再解析
            </button>
          )}
          <button
            type="button"
            onClick={translateAllToJa}
            disabled={disabled || Boolean(bulk) || !kept.some((p) => p.caption.trim() && !p.captionJa.trim())}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Languages size={13} />
            🇯🇵 全カードを日本語に
          </button>
          <button
            type="button"
            onClick={translateAllToEn}
            disabled={disabled || Boolean(bulk) || !kept.some((p) => p.captionJa.trim())}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Languages size={13} />
            🇬🇧 日本語を英語へ一括反映
          </button>
          <button
            type="button"
            onClick={downloadDataset}
            disabled={disabled || zipping || Boolean(bulk) || kept.length === 0}
            title="現在残っている画像とキャプション(.txt)を1つのZIPにまとめて保存します。"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {zipping ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            📦 データセットDL (画像+txt)
          </button>
        </div>
      </div>

      {(overCount || overBytes) && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
          {overCount && `画像は最大 ${maxImages} 枚までです（あと ${kept.length - maxImages} 枚除外してください）。`}
          {overBytes && ` 合計サイズが上限（${fmtMb(maxTotalBytes)}）を超えています。`}
        </p>
      )}

      {formatMismatch && onRecaption && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-amber-300">
            ⚠️ キャプション形式の不整合:
            現在のモデルには【Dense（自然言語散文）】が適用されていますが、既存カードの多くが【Tags（タグ列）】形式です。
          </p>
          <button
            type="button"
            onClick={forceRecaptionAll}
            disabled={disabled || Boolean(bulk) || recappingIds.size > 0}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-400/70 bg-amber-400/20 px-3 py-1.5 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-400/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {recappingIds.size > 0 ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RotateCcw size={13} />
            )}
            現在の形式で全カードを一括修復
          </button>
        </div>
      )}
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">{error}</p>
      )}

      <div className="grid max-h-[32rem] gap-2 overflow-y-auto pr-1">
        {pairs.map((p, idx) => {
          const b = busyId[p.id];
          return (
            <div
              key={p.id}
              className={`flex gap-3 rounded-xl border p-2.5 transition-colors ${
                p.excluded ? "border-border bg-background/30 opacity-50" : "border-border bg-background/50"
              }`}
            >
              <div className="flex w-24 shrink-0 flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setLightboxIndex(idx)}
                  title="クリックで拡大（細部をズーム確認）"
                  className={`group relative flex aspect-square w-24 items-center justify-center overflow-hidden rounded-lg border border-border bg-neutral-900 ${
                    p.excluded ? "grayscale" : ""
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={p.name}
                    className="h-full w-full object-contain"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                    <ZoomIn size={16} />
                  </span>
                </button>
                <span className="w-full truncate text-center font-mono text-[9px] text-muted" title={p.name}>
                  {p.name}
                </span>
                <button
                  type="button"
                  onClick={() => patch(p.id, { excluded: !p.excluded })}
                  disabled={disabled || Boolean(bulk)}
                  className={`inline-flex w-full items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-[10px] transition-colors disabled:opacity-50 ${
                    p.excluded
                      ? "border-neon-violet/40 text-neon-violet hover:bg-neon-violet/10"
                      : "border-border text-muted hover:border-red-400/50 hover:text-red-400"
                  }`}
                >
                  {p.excluded ? (
                    <>
                      <RotateCcw size={11} /> 戻す
                    </>
                  ) : (
                    <>
                      <Trash2 size={11} /> 除外
                    </>
                  )}
                </button>
                {onRecaption && !p.excluded && !p.caption.trim() && (
                  <button
                    type="button"
                    onClick={() => void runRecaption([p])}
                    disabled={disabled || Boolean(bulk) || recappingIds.has(p.id)}
                    className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-amber-400/50 px-1.5 py-1 text-[10px] text-amber-300 transition-colors hover:bg-amber-400/10 disabled:opacity-50"
                  >
                    {recappingIds.has(p.id) ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <RotateCcw size={11} />
                    )}
                    再解析
                  </button>
                )}
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-[10px] font-medium text-muted">英語タグ / English（学習に使用）</label>
                    <button
                      type="button"
                      onClick={() => runTranslate(p.id, "ja")}
                      disabled={disabled || Boolean(b) || !p.caption.trim() || p.excluded}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {b === "ja" ? <Loader2 size={10} className="animate-spin" /> : <span>🇯🇵</span>}
                      日本語に翻訳
                    </button>
                  </div>
                  <textarea
                    value={p.caption}
                    onChange={(e) => patch(p.id, { caption: e.target.value })}
                    placeholder="(空欄 = 自動タグ付け)"
                    rows={2}
                    disabled={disabled || p.excluded || Boolean(bulk)}
                    className={`${inputCls} resize-none font-mono`}
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-[10px] font-medium text-muted">日本語（確認・修正用）</label>
                    <button
                      type="button"
                      onClick={() => runTranslate(p.id, "en")}
                      disabled={disabled || Boolean(b) || !p.captionJa.trim() || p.excluded}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {b === "en" ? <Loader2 size={10} className="animate-spin" /> : <span>🇬🇧</span>}
                      英語に反映（逆翻訳）
                    </button>
                  </div>
                  <textarea
                    value={p.captionJa}
                    onChange={(e) => patch(p.id, { captionJa: e.target.value })}
                    placeholder="「日本語に翻訳」で自動入力、または直接入力"
                    rows={2}
                    disabled={disabled || p.excluded || Boolean(bulk)}
                    className={`${inputCls} resize-none`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled || Boolean(bulk)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-50"
        >
          <ArrowLeft size={13} />
          戻る
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Flame size={15} />
          {`🔥 このデータセットで学習を開始 (${requiredCredits} C)`}
        </button>
      </div>

      {lightboxIndex != null && lightboxItems[lightboxIndex] && (
        <ImageLightbox
          items={lightboxItems}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onCaptionChange={(id, caption) => patch(id, { caption })}
          disabled={disabled || Boolean(bulk)}
        />
      )}
    </div>
  );
}
