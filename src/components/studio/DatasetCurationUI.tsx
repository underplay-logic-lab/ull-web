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
import {
  matchLeadingSubjectTriggers,
  normalizeSubjectTags,
  stripLeadingSubjectTriggers,
  type LoraSubject,
  type ResolvedCaptionMode,
  FEATURE_GENERIC_TAIL,
} from "@/lib/loraCaptionSpec";

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

export function DatasetCurationUI({
  pairs,
  onChange,
  onConfirm,
  onCancel,
  requiredCredits,
  triggerWord,
  subjects,
  maxImages,
  maxTotalBytes,
  disabled = false,
  onRecaption,
  resolvedCaptionMode = "tags",
  canDownloadDataset = false,
  featureTerms = [],
}: {
  pairs: CurationPair[];
  // A setState updater — every mutation is applied against the freshest state
  // so an exclude toggle can never clobber (or be clobbered by) an in-flight
  // translation landing on a different card.
  /**
   * 学習前のデータセットDLを出してよいか。2026-09-21 は admin 限定（キャプションが無料だったため）。
   * 2026-09-25 からキャプション作成が有料になったので、AI キャプションを作った後、またはキャプションを
   * 自分で用意した場合は誰でも DL できる（判定は呼び出し側 LoraStudioTab）。
   */
  canDownloadDataset?: boolean;
  /**
   * 「学習したい特徴」（キャプションに書かせない言葉、英タグ）。キャプションに混ざっていないかを数えて出し、
   * 押すとその語で検索する（2026-09-25、ホスト報告「metal frame glasses が何枚か混ざっている」）。
   */
  featureTerms?: string[];
  onChange: Dispatch<SetStateAction<CurationPair[]>>;
  onConfirm: () => void;
  onCancel: () => void;
  requiredCredits: number;
  // The trigger token — kept verbatim through translation (Gemini otherwise
  // transliterates it, e.g. yukipas -> yukipasu on the reverse pass).
  triggerWord: string;
  // 2+ entries = multi-subject mode: each card shows which subject's trigger
  // its caption starts with (derived from the caption text itself, not a
  // separate field) and lets the user reassign it. undefined/1 entry =
  // legacy single-trigger behaviour (triggerWord above), unchanged.
  subjects?: LoraSubject[];
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
      // 別state対応（2026-09-15）: LoraStudioTab.tsx側の同名処理と同じ共有
      // ロジック（normalizeSubjectTags）を、curationPairsの最新値に
      // 対して適用する。functional updater で読むので、直前のonChangeが
      // まだ反映されていない古いclosureのpairsを見てしまう心配がない。
      const subjectList = subjects && subjects.length >= 1 ? subjects : [{ trigger: triggerWord.trim(), description: "" }];
      // タグ列の整形なので文章形式には掛けない（2026-09-25）。
      if (subjectList[0]?.trigger && resolvedCaptionMode !== "dense") {
        onChange((prev) => {
          const fixes = normalizeSubjectTags(
            prev.map((p) => ({ id: p.id, caption: p.caption })),
            subjectList,
          );
          if (!fixes.size) return prev;
          return prev.map((p) => (fixes.has(p.id) ? { ...p, caption: fixes.get(p.id)! } : p));
        });
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

  // --- 検索・置換（2026-09-25）---
  const [search, setSearch] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const needle = search.trim().toLowerCase();
  const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matchIds = useMemo(
    () =>
      new Set(
        needle
          ? pairs
              .filter((p) => p.caption.toLowerCase().includes(needle) || p.captionJa.toLowerCase().includes(needle))
              .map((p) => p.id)
          : [],
      ),
    [pairs, needle],
  );
  // 表示の絞り込みは「この検索で一度でも一致したカード」で行う（2026-09-25、ホスト報告「glasses の g を消した
  // 瞬間にカードが消える」）。手で直している途中に一致しなくなっても、一覧から消さない。検索語が変わったら作り直す。
  const [stickyMatch, setStickyMatch] = useState<{ needle: string; ids: Set<string> }>({ needle: "", ids: new Set() });
  let shownMatchIds = stickyMatch.ids;
  if (stickyMatch.needle !== needle) {
    shownMatchIds = new Set(matchIds);
    setStickyMatch({ needle, ids: shownMatchIds });
  } else if ([...matchIds].some((id) => !stickyMatch.ids.has(id))) {
    shownMatchIds = new Set([...stickyMatch.ids, ...matchIds]);
    setStickyMatch({ needle, ids: shownMatchIds });
  }
  const enMatchCount = useMemo(
    () => (needle ? pairs.filter((p) => !p.excluded && p.caption.toLowerCase().includes(needle)).length : 0),
    [pairs, needle],
  );
  // 置換は学習に使う英語側だけ。変えたカードの日本語は消す（残すと「英語に反映」で元に戻ってしまう）。
  // 2026-09-25（ホスト指摘「押すと一瞬で消えて、消えたのか・どこまで消えたのか分からない」）:
  //   - 消す範囲を選べる: 語句だけ ／ その語を含むカンマ区切りの部分ごと（"metal frame glasses" を丸ごと等）
  //   - 結果を要約と変更前後の例で出し、変えたカードを表示したままにする（検索に一致しなくなって消えていた）
  //   - 元に戻せる
  const [replaceScope, setReplaceScope] = useState<"phrase" | "segment">("phrase");
  const [lastReplace, setLastReplace] = useState<{
    ids: Set<string>;
    before: Record<string, { caption: string; captionJa: string }>;
    summary: string;
    examples: { before: string; after: string }[];
  } | null>(null);
  const tidy = (t: string) =>
    t
      .replace(/\s+([,.])/g, "$1")
      .replace(/,\s*,/g, ",")
      .replace(/\.\s*\./g, ".")
      .replace(/\s{2,}/g, " ")
      .replace(/^[,\s]+|[,\s]+$/g, "")
      .trim();
  const replaceIn = (caption: string): string => {
    const re = new RegExp(escapeRe(search.trim()), "gi");
    const to = replaceWith.trim();
    if (replaceScope === "segment") {
      // カンマ区切りの部分（タグ 1 つ・文の一節）ごと。置き換える語があればその部分をまるごと置き換える。
      const parts = caption.split(/,/);
      const out = parts
        .map((seg) => (new RegExp(escapeRe(search.trim()), "i").test(seg) ? (to ? ` ${to}` : null) : seg))
        .filter((x): x is string => x !== null);
      return tidy(out.join(","));
    }
    return tidy(caption.replace(re, to));
  };
  const applyReplace = () => {
    if (!needle) return;
    const before: Record<string, { caption: string; captionJa: string }> = {};
    const examples: { before: string; after: string }[] = [];
    for (const p of pairs) {
      if (p.excluded || !p.caption.toLowerCase().includes(needle)) continue;
      const after = replaceIn(p.caption);
      if (after === p.caption) continue;
      before[p.id] = { caption: p.caption, captionJa: p.captionJa };
      if (examples.length < 3) examples.push({ before: p.caption, after });
    }
    const ids = new Set(Object.keys(before));
    if (ids.size === 0) return;
    onChange((prev) =>
      prev.map((p) => (ids.has(p.id) ? { ...p, caption: replaceIn(p.caption), captionJa: "" } : p)),
    );
    const what = replaceScope === "segment" ? `「${search.trim()}」を含む部分` : `「${search.trim()}」`;
    setLastReplace({
      ids,
      before,
      summary: `${ids.size} 枚の英語キャプションで、${what}を${
        replaceWith.trim() ? `「${replaceWith.trim()}」に置き換えました` : "削除しました"
      }。`,
      examples,
    });
    setReplaceWith("");
  };
  const undoReplace = () => {
    if (!lastReplace) return;
    const { before } = lastReplace;
    onChange((prev) => prev.map((p) => (before[p.id] ? { ...p, ...before[p.id] } : p)));
    setLastReplace(null);
  };
  // 学習したい特徴がキャプションに何枚混ざっているか。句で数え、最後の語が特徴的（glasses / beard 等）なら
  // その語で数える（"metal frame glasses" は "round glasses" では当たらないため）。
  const featureChips = useMemo(() => {
    const GENERIC = FEATURE_GENERIC_TAIL;
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const t of featureTerms) {
      const phrase = t.trim().toLowerCase();
      if (!phrase) continue;
      const last = phrase.split(/\s+/).pop() ?? phrase;
      const term = GENERIC.has(last) ? phrase : last;
      if (!seen.has(term)) {
        seen.add(term);
        terms.push(term);
      }
    }
    return terms.map((term) => {
      const re = new RegExp(`\\b${escapeRe(term)}\\b`, "i");
      return { term, count: kept.filter((p) => re.test(p.caption)).length };
    });
  }, [featureTerms, kept]);
  const featureHits = featureChips.filter((c) => c.count > 0);
  const [toolsOpen, setToolsOpen] = useState(false);
  // 検索中・置換の結果を出している間は閉じられないようにする（閉じると絞り込みの理由が見えなくなる）。
  const showTools = toolsOpen || Boolean(search.trim()) || Boolean(lastReplace);
  const keptBytes = useMemo(() => kept.reduce((s, p) => s + p.file.size, 0), [kept]);
  const overCount = kept.length > maxImages;
  const overBytes = keptBytes > maxTotalBytes;
  // キャプションが空の画像が残っている間は学習へ進めない（2026-09-25 ホスト判断。学習側の自動補完に頼らない。
  // 「自分で書く」を選んだ場合はここが書く場所）。学習に送るのは英語側なので、英語が空なら未記入扱い。
  const blankCount = kept.filter((p) => !p.caption.trim()).length;
  const canConfirm = !disabled && kept.length >= 1 && !overCount && !overBytes && !bulk && blankCount === 0;

  const patch = (id: string, next: Partial<CurationPair>) =>
    onChange((prev) => prev.map((p) => (p.id === id ? { ...p, ...next } : p)));

  const patchMany = (updates: Record<string, Partial<CurationPair>>) => {
    if (Object.keys(updates).length === 0) return;
    onChange((prev) => prev.map((p) => (updates[p.id] ? { ...p, ...updates[p.id] } : p)));
  };

  // Protect the trigger token from the translator: peel a leading trigger
  // (with optional trailing comma, EN or JP) off before sending, and glue the
  // ORIGINAL trigger(s) back on after. Multi-subject (subjects.length >= 2):
  // each caption may start with a DIFFERENT one — or, for a group/couple
  // shot, MORE THAN ONE — of them, so detect exactly which ones THIS text
  // actually has and preserve exactly those, never the fixed `triggerWord`
  // prop (only the primary/first subject).
  const trig = triggerWord.trim();
  const subjectList: LoraSubject[] = subjects && subjects.length >= 1 ? subjects : [{ trigger: trig, description: "" }];
  const stripTrigger = (s: string) => stripLeadingSubjectTriggers(s, subjectList);
  // Which trigger(s) to preserve for `text` MUST be read from the ORIGINAL
  // (pre-translation) text — the translated body no longer starts with any
  // trigger word (it was stripped before sending), so re-detecting from the
  // output would always miss and silently fall back to the wrong subject.
  const triggerFor = (originalText: string): string => {
    const present = matchLeadingSubjectTriggers(originalText, subjectList);
    return present.length ? present.map((s) => s.trigger).join(", ") : trig;
  };
  const withTrigger = (translatedBody: string, triggerBlock: string) => {
    const body = translatedBody.trim();
    if (!triggerBlock) return body;
    return body ? `${triggerBlock}, ${body}` : triggerBlock;
  };

  // One translation call with the trigger peeled off + re-attached. Returns
  // null when there's nothing (but the trigger) to translate.
  const translateProtected = async (text: string, dir: "ja" | "en"): Promise<string | null> => {
    const trigger = triggerFor(text);
    const body = stripTrigger(text).trim();
    if (!body) return trigger ? trigger : null;
    const out = await translateCaption(body, dir === "ja" ? "to_ja" : "to_en", resolvedCaptionMode);
    return withTrigger(out, trigger);
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
    let failed = 0;
    let lastErr = "";
    try {
      const CHUNK = 12;
      for (let i = 0; i < targets.length; i += CHUNK) {
        const chunk = targets.slice(i, i + CHUNK);
        const originals = chunk.map((t) => (dir === "ja" ? t.caption : t.captionJa));
        const triggers = originals.map((o) => triggerFor(o));
        const bodies = originals.map((o) => stripTrigger(o).trim());
        const sendIdx = bodies.map((b, k) => (b ? k : -1)).filter((k) => k >= 0);

        const outs = new Array<string>(chunk.length).fill("");
        if (sendIdx.length) {
          const action = dir === "ja" ? "to_ja" : "to_en";
          try {
            const res = await translateCaptionsBatch(
              sendIdx.map((k) => bodies[k]),
              action,
              resolvedCaptionMode,
            );
            sendIdx.forEach((k, j) => {
              outs[k] = res[j] ?? "";
            });
          } catch (err) {
            // まとめて失敗したら 1 枚ずつやり直す（2026-09-25、ホスト報告「全カードを日本語にで翻訳に失敗」）。
            // 以前は 12 枚のうち 1 枚が断られる（露骨な内容等）・返事が崩れるだけで、残り全部が止まっていた。
            lastErr = err instanceof Error ? err.message : "翻訳に失敗しました";
            for (const k of sendIdx) {
              try {
                outs[k] = await translateCaption(bodies[k], action, resolvedCaptionMode);
              } catch (e) {
                lastErr = e instanceof Error ? e.message : lastErr;
              }
            }
          }
          failed += sendIdx.filter((k) => !outs[k]).length;
        }

        const updates: Record<string, Partial<CurationPair>> = {};
        chunk.forEach((t, k) => {
          if (!bodies[k]) {
            // caption was only the trigger (or blank)
            if (triggers[k]) updates[t.id] = dir === "ja" ? { captionJa: triggers[k] } : { caption: triggers[k] };
            return;
          }
          if (!outs[k]) return; // this item failed to translate — leave it
          const val = withTrigger(outs[k], triggers[k]);
          updates[t.id] = dir === "ja" ? { captionJa: val } : { caption: val };
        });
        patchMany(updates);

        setBulk({ done: Math.min(i + CHUNK, targets.length), total: targets.length });
        if (i + CHUNK < targets.length) await new Promise((r) => setTimeout(r, 900));
      }
      if (failed > 0) {
        setError(
          `${failed} 枚は翻訳できませんでした${lastErr ? `（${lastErr}）` : ""}。そのカードだけ「${
            dir === "ja" ? "日本語に翻訳" : "英語に反映"
          }」で個別にやり直せます。`,
        );
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
          {canDownloadDataset && (
          <button
            type="button"
            onClick={downloadDataset}
            disabled={disabled || zipping || Boolean(bulk) || kept.length === 0}
            title="【admin限定】現在残っている画像とキャプション(.txt)を1つのZIPにまとめて保存します。"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {zipping ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            📦 データセットDL (画像+txt)（admin）
          </button>
          )}
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

      {/* キャプションのチェック結果（2026-09-25、ホスト指摘「特徴が入っていません、では良いのか悪いのか分からない」）。
          学習したい特徴が混ざっていなければ結果だけを 1 行、混ざっていれば該当の語を出して、押すと絞り込む。 */}
      {featureChips.length > 0 &&
        (featureHits.length === 0 ? (
          <p className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-[11px] text-green-400">
            ✓ チェック完了: すべて正しくキャプションされています。
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[10px]">
            <span className="text-amber-300">
              ⚠️ 直した方がいいキャプションがあります（トリガーワードに覚えさせたい特徴が書かれています）。押すと該当の画像だけ表示します:
            </span>
            {featureHits.map(({ term, count }) => (
              <button
                key={term}
                type="button"
                onClick={() => {
                  setSearch(term);
                  setOnlyMatches(true);
                  setToolsOpen(true);
                }}
                className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-amber-300 transition-colors hover:bg-amber-500/20"
              >
                {term}（{count}枚）
              </button>
            ))}
          </div>
        ))}

      {/* キャプションの検索・置換（2026-09-25、ホスト指摘「特徴が混ざったキャプションを直すのに検索が要る」）。
          普段は畳む（AI の自己チェックで直っていれば使わないため）。特徴が混ざっている・検索中は開く。 */}
      <div className="space-y-2 rounded-lg border border-border bg-background/40 px-3 py-2">
        <button
          type="button"
          onClick={() => {
            if (!showTools) return setToolsOpen(true);
            // 閉じるときは検索と置換の結果も片付けて、全カードの表示に戻す。
            setToolsOpen(false);
            setSearch("");
            setLastReplace(null);
          }}
          className="flex w-full items-center justify-between text-[11px] font-medium text-foreground"
        >
          <span>一括で直す（検索・置換）</span>
          <span className="text-muted">{showTools ? "▲ 閉じる" : "▼ 開く"}</span>
        </button>
        {showTools && (
        <>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="キャプションを検索（英語・日本語）"
            className={`${inputCls} w-56`}
          />
          {needle && (
            <>
              <span className="text-muted">{matchIds.size} 枚が一致</span>
              <label className="flex items-center gap-1 text-muted">
                <input
                  type="checkbox"
                  checked={onlyMatches}
                  onChange={(e) => setOnlyMatches(e.target.checked)}
                  className="accent-neon-violet"
                />
                一致したものだけ表示
              </label>
            </>
          )}
        </div>
        {needle && enMatchCount > 0 && (
          <div className="space-y-1.5 text-[11px]">
            <div className="flex flex-wrap items-center gap-3 text-muted">
              <span>消す範囲:</span>
              {(
                [
                  ["phrase", "語句だけ"],
                  ["segment", "その語を含むカンマ区切りの部分ごと（例: metal frame glasses をまるごと）"],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="caption-replace-scope"
                    checked={replaceScope === v}
                    onChange={() => setReplaceScope(v)}
                    className="accent-neon-violet"
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={replaceWith}
                onChange={(e) => setReplaceWith(e.target.value)}
                placeholder="置き換える語（空なら削除）"
                className={`${inputCls} w-56`}
              />
              <button
                type="button"
                disabled={disabled || Boolean(bulk)}
                onClick={applyReplace}
                className="rounded-md border border-neon-violet/50 bg-neon-violet/10 px-2.5 py-1 font-medium text-neon-violet hover:bg-neon-violet/20 disabled:opacity-50"
              >
                英語キャプション {enMatchCount} 枚{replaceWith.trim() ? "で置換" : "から削除"}
              </button>
              <span className="text-[10px] text-muted">
                学習に使う英語側だけ変えます。変えたカードの日本語は消えるので、あとで「全カードを日本語に」で作り直してください。
              </span>
            </div>
          </div>
        )}
        {lastReplace && (
          <div className="space-y-1 rounded-md border border-green-500/40 bg-green-500/10 px-2.5 py-1.5 text-[11px] text-green-300">
            <div className="flex flex-wrap items-center gap-2">
              <span>✓ {lastReplace.summary}</span>
              <button
                type="button"
                onClick={undoReplace}
                disabled={disabled || Boolean(bulk)}
                className="rounded-md border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground disabled:opacity-50"
              >
                元に戻す
              </button>
              <button
                type="button"
                onClick={() => setLastReplace(null)}
                className="text-[10px] text-muted underline hover:text-foreground"
              >
                閉じる（全カードの表示に戻る）
              </button>
            </div>
            {lastReplace.examples.map((ex, k) => (
              <div key={k} className="text-[10px] leading-relaxed text-muted">
                <div>
                  <span className="text-red-300">前:</span> {ex.before}
                </div>
                <div>
                  <span className="text-green-300">後:</span> {ex.after}
                </div>
              </div>
            ))}
            <p className="text-[10px] text-muted">下には変えた {lastReplace.ids.size} 枚だけを表示しています。</p>
          </div>
        )}
        </>
        )}
      </div>

      <div className="grid max-h-[48rem] gap-2 overflow-y-auto pr-1">
        {pairs.map((p, idx) => {
          // 置換した直後は、変えたカードだけを表示する（検索に一致しなくなって消えたように見えないように）。
          if (lastReplace) {
            if (!lastReplace.ids.has(p.id)) return null;
          } else if (onlyMatches && needle && !shownMatchIds.has(p.id)) return null;
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
                {subjects && subjects.length >= 2 && (() => {
                  const present = matchLeadingSubjectTriggers(p.caption, subjects);
                  const presentSet = new Set(present.map((s) => s.trigger));
                  return (
                    <div className="flex flex-wrap items-center gap-1">
                      <span
                        className={`text-[10px] font-medium ${present.length ? "text-muted" : "text-amber-400"}`}
                      >
                        {present.length ? "被写体:" : "⚠️ 被写体未判定:"}
                      </span>
                      {subjects.map((s) => {
                        const active = presentSet.has(s.trigger);
                        return (
                          <button
                            key={s.trigger}
                            type="button"
                            title={s.description || s.trigger}
                            disabled={disabled || p.excluded || Boolean(bulk)}
                            onClick={() => {
                              // 複数人物が写る画像は、写っている全員分をON
                              // にできる（グループ/カップル写真対応）。
                              const nextSubjects = active
                                ? subjects.filter((x) => x.trigger !== s.trigger && presentSet.has(x.trigger))
                                : [...present, s];
                              const ordered = subjects.filter((x) =>
                                nextSubjects.some((n) => n.trigger === x.trigger),
                              );
                              const body = stripLeadingSubjectTriggers(p.caption, subjects);
                              const block = ordered.map((x) => x.trigger).join(", ");
                              patch(p.id, { caption: block ? `${block}, ${body}` : body });
                            }}
                            className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors disabled:opacity-50 ${
                              active
                                ? "border-neon-violet/50 bg-neon-violet/10 text-neon-violet"
                                : "border-border text-muted hover:border-neon-violet/30"
                            }`}
                          >
                            {s.trigger}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
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
                    rows={7}
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
                    rows={5}
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
        {blankCount > 0 && (
          <p className="text-[11px] text-amber-400">
            キャプションが空の画像が {blankCount} 枚あります。全部に入れると学習を開始できます
            （日本語だけ書いた場合は「🇬🇧 日本語を英語へ一括反映」を押してください）。
          </p>
        )}
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
