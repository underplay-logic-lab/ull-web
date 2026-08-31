import { supabase } from "@/lib/supabaseClient";
import {
  buildCaptionFallbackPrompt,
  captionSpecHasInput,
  type LoraCaptionSpec,
} from "@/lib/loraCaptionSpec";

export type CaptionPromptResult = {
  captionPrompt: string;
  /** true when Gemini produced it, false when the deterministic fallback did. */
  fromGemini: boolean;
};

// Calls /api/studio/lora/caption-prompt (Gemini free tier) to turn the
// selected LoRA type + the user's Japanese fixed/varying feature notes into
// the English instruction handed to the Modal worker's Qwen captioner.
//
// Never throws: on any failure it falls back to the deterministic,
// LLM-free prompt so advancing to training is never blocked by Gemini being
// down. Returns null only when the spec has no usable input at all.
export async function generateCaptionPrompt(
  spec: LoraCaptionSpec,
  triggerWord: string,
): Promise<CaptionPromptResult | null> {
  if (!captionSpecHasInput(spec)) return null;

  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("no session");

    const res = await fetch("/api/studio/lora/caption-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        category: spec.category,
        fixed: spec.fixed,
        varying: spec.varying,
        trigger_word: triggerWord,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && typeof body?.captionPrompt === "string" && body.captionPrompt.trim()) {
      return { captionPrompt: body.captionPrompt.trim(), fromGemini: true };
    }
    console.warn("[loraCaptionPrompt] generation failed, using fallback:", body?.error || res.status);
  } catch (err) {
    console.warn("[loraCaptionPrompt] generation errored, using fallback:", err);
  }

  return { captionPrompt: buildCaptionFallbackPrompt(spec, triggerWord), fromGemini: false };
}
