import "server-only";

// Hiragana, katakana, kanji, and fullwidth punctuation — any hit means the
// prompt contains Japanese multibyte text that FLUX (trained on English
// captions) won't parse well.
const JAPANESE_PATTERN = /[぀-ゟ゠-ヿ一-鿿＀-￯]/;

export function containsJapanese(text: string): boolean {
  return JAPANESE_PATTERN.test(text);
}

type GoogleTranslateResponse = [Array<[string, string]>, ...unknown[]];

// Free, key-less translation via Google Translate's public web endpoint —
// the same one packages like google-translate-api-x wrap. Any failure
// (network, shape change) falls back to the original prompt so a
// translation outage never blocks image generation.
export async function translateToEnglish(text: string): Promise<string> {
  if (!containsJapanese(text)) return text;

  try {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "ja");
    url.searchParams.set("tl", "en");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Translate request failed (${res.status}).`);
    }

    const data = (await res.json()) as GoogleTranslateResponse;
    const segments = data[0];

    if (!Array.isArray(segments)) {
      throw new Error("Unexpected translate response shape.");
    }

    const translated = segments.map(([sentence]) => sentence ?? "").join("");
    return translated.trim() || text;
  } catch (err) {
    console.error("[translate] falling back to original prompt:", err);
    return text;
  }
}
