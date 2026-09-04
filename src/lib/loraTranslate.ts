import { supabase } from "@/lib/supabaseClient";
import type { ResolvedCaptionMode } from "@/lib/loraCaptionSpec";

export type TranslateAction = "to_ja" | "to_en";

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("ログインが必要です。");
  return token;
}

// Calls /api/studio/lora/translate (Gemini free tier). "to_ja" turns an
// English caption into Japanese; "to_en" turns the user's edited Japanese
// back into an English caption for training — in the format `mode` asks for
// ("dense" = natural prose for Minimax H3 & co.; "tags" = Danbooru comma
// list, the default when omitted).
export async function translateCaption(
  text: string,
  action: TranslateAction,
  mode?: ResolvedCaptionMode,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const res = await fetch("/api/studio/lora/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await accessToken()}` },
    body: JSON.stringify({ text: trimmed, action, caption_type: mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.reason || "翻訳に失敗しました。");
  return typeof data?.translation === "string" ? data.translation : "";
}

// One Gemini call for a whole chunk of captions — keeps the 15 RPM free tier
// comfortably out of reach even for a large dataset. Returns a list aligned
// to `texts` (empty string where a caption came back blank).
export async function translateCaptionsBatch(
  texts: string[],
  action: TranslateAction,
  mode?: ResolvedCaptionMode,
): Promise<string[]> {
  if (texts.length === 0) return [];

  const res = await fetch("/api/studio/lora/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await accessToken()}` },
    body: JSON.stringify({ items: texts, action, caption_type: mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.reason || "翻訳に失敗しました。");
  const out = Array.isArray(data?.translations) ? (data.translations as unknown[]) : [];
  return texts.map((_, i) => (typeof out[i] === "string" ? (out[i] as string) : ""));
}
