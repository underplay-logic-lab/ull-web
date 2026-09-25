import "server-only";
import {
  applySubjectFixedTags,
  buildCategoryDefaultInstruction,
  coerceLoraCaptionCategory,
  type LoraSubject,
  type ResolvedCaptionMode,
} from "@/lib/loraCaptionSpec";
import { parseEnJaArray, tidyCaption } from "@/lib/loraCaptionVision";
import { evaluateContentPolicyMany, logContentPolicyBlock } from "@/lib/contentPolicy";

// LoRA キャプション解析の「依頼内容の検証・指示文の材料づくり」と「結果の整形」。
// Gemini 経路（/api/studio/lora/caption）と自前 VLM 経路（/api/studio/lora/caption-vlm）で
// 同じものを通す（2026-09-24）。経路によって書き方が変わらないよう、ここだけを正にする。

export type CaptionRequestSpec = {
  triggerWord: string;
  subjects: LoraSubject[];
  captionPrompt: string;
  captionMode: ResolvedCaptionMode;
};

/** body から依頼内容を取り出す。内容ポリシーに触れたら { blocked: true }。 */
export function parseCaptionRequest(
  body: unknown,
  userId: string,
  logTag: string,
): { blocked: true } | { blocked: false; spec: CaptionRequestSpec } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const triggerWord = typeof b.trigger_word === "string" ? b.trigger_word.trim().slice(0, 60) : "";
  // Multiple distinct subjects (2026-09-15) — each with its own trigger word and a short
  // description used to tell them apart in the vision prompt. Falls back to the single
  // legacy `trigger_word` when absent.
  const rawSubjects = Array.isArray(b.subjects) ? b.subjects : [];
  const parsedSubjects: LoraSubject[] = rawSubjects
    .map((s: unknown) => {
      const o = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
      return {
        trigger: typeof o.trigger === "string" ? o.trigger.trim().slice(0, 60) : "",
        description: typeof o.description === "string" ? o.description.trim().slice(0, 300) : "",
        fixedTags: typeof o.fixedTags === "string" ? o.fixedTags.trim().slice(0, 200) : "",
      };
    })
    .filter((s: LoraSubject) => s.trigger.length > 0)
    .slice(0, 8);
  const subjects: LoraSubject[] =
    parsedSubjects.length >= 1 ? parsedSubjects : [{ trigger: triggerWord, description: "", fixedTags: "" }];
  // Explicit instruction wins; else the training CATEGORY's built-in policy — never
  // "describe the whole image", which would hollow out the trigger word.
  const category = coerceLoraCaptionCategory(b.category ?? b.learning_type);
  let captionPrompt = typeof b.caption_prompt === "string" ? b.caption_prompt.slice(0, 4000) : "";
  if (!captionPrompt.trim() && category) {
    captionPrompt = buildCategoryDefaultInstruction(category, triggerWord);
  }
  const policyResult = evaluateContentPolicyMany([
    triggerWord,
    captionPrompt,
    ...subjects.flatMap((s) => [s.trigger, s.description, s.fixedTags ?? ""]),
  ]);
  if (policyResult.blocked) {
    logContentPolicyBlock(logTag, policyResult, userId);
    return { blocked: true };
  }
  const captionMode: ResolvedCaptionMode = b.caption_mode === "dense" ? "dense" : "tags";
  return { blocked: false, spec: { triggerWord, subjects, captionPrompt, captionMode } };
}

/** 解析結果（{ en, ja } の配列）を本番の形に整える。 */
export function finalizeCaptions(
  parsed: { en?: string; ja?: string }[],
  spec: Pick<CaptionRequestSpec, "subjects" | "captionMode">,
): { captions: string[]; captionsJa: string[] } {
  // 性別/人数タグの差し込みはタグ形式だけ（文章に差し込むと文が壊れる。2026-09-25）。
  const captions = parsed.map((p) => {
    const tidy = tidyCaption(p.en ?? "", spec.subjects, spec.captionMode);
    return spec.captionMode === "tags" ? applySubjectFixedTags(tidy, spec.subjects) : tidy;
  });
  const captionsJa = parsed.map((p, i) =>
    captions[i].trim()
      ? (p.ja ?? "").trim().replace(/\s*\n+\s*/g, spec.captionMode === "dense" ? " " : "、")
      : "",
  );
  return { captions, captionsJa };
}

/** 1 枚ずつの生出力（JSON 配列 1 要素の文字列）を整形する。解釈できない枠は空文字。 */
export function finalizeRawSingles(
  raws: (string | null | undefined)[],
  spec: Pick<CaptionRequestSpec, "subjects" | "captionMode">,
): { captions: string[]; captionsJa: string[] } {
  const parsed = raws.map((raw) => (raw ? parseEnJaArray(raw, 1)?.[0] : undefined) ?? { en: "", ja: "" });
  return finalizeCaptions(parsed, spec);
}
