// LoRA キャプション解析のモデル比較（2026-09-24）。
//
// 本番と同じ指示文（src/lib/loraCaptionVision.ts）・同じ Gemini 呼び出し（runGeminiVision）で、
// 同じ画像を複数モデルに解析させ、キャプションとトークン数を JSON に書き出す。
// 利用トークンは本番と同じく ai_usage_logs に feature="caption_model_compare" で残る。
//
//   npx tsx --conditions=react-server scripts/caption_model_compare.ts <manifest.json> <out.json> [trigger]
//
// manifest.json は [{ name, path }]（長辺 640 の JPEG。本番のブラウザ側縮小と同条件）。
// --conditions=react-server は geminiText → supabaseAdmin の "server-only" を通すため。
import { readFileSync, writeFileSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { runGeminiVision } from "@/lib/geminiText";
import { buildVisionPrompt, parseEnJaArray, tidyCaption } from "@/lib/loraCaptionVision";
import { buildCategoryDefaultInstruction, type LoraSubject } from "@/lib/loraCaptionSpec";

// CMP_MODELS=a,b で絞れる。CMP_MODE=dense で文章形式（DiT 用）を比べる（2026-09-24）。
const MODELS = process.env.CMP_MODELS
  ? process.env.CMP_MODELS.split(",")
  : ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"];
const MODE: "tags" | "dense" = process.env.CMP_MODE === "dense" ? "dense" : "tags";
const BATCH = 4; // 本番の CAPTION_BATCH_SIZE と同じ

async function main() {
  const [manifestPath, outPath, triggerArg] = process.argv.slice(2);
  if (!manifestPath || !outPath) throw new Error("usage: <manifest.json> <out.json> [trigger]");
  const trigger = triggerArg || "yukipas";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name: string; path: string }[];
  const images = manifest.map((m) => ({ mimeType: "image/jpeg", data: readFileSync(m.path).toString("base64") }));
  const subjects: LoraSubject[] = [{ trigger, description: "" }];
  const captionPrompt = buildCategoryDefaultInstruction("character", trigger);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

  const result: Record<string, { name: string; en: string; ja: string }[]> = {};
  for (const model of MODELS) {
    // runGeminiVision は GEMINI_MODEL を候補の先頭に置く。失敗時は別モデルへ落ちるので、
    // どのモデルで返ったかは ai_usage_logs / ログの [gemini-usage] 行で確かめる。
    process.env.GEMINI_MODEL = model;
    const rows: { name: string; en: string; ja: string }[] = [];
    for (let s = 0; s < images.length; s += BATCH) {
      const batch = images.slice(s, s + BATCH);
      const prompt = buildVisionPrompt(batch.length, subjects, captionPrompt, MODE);
      let parsed: { en: string; ja: string }[] | null = null;
      try {
        const raw = await runGeminiVision(genAI, prompt, batch, "enja", {
          feature: "caption_model_compare",
          images: batch.length,
        });
        parsed = parseEnJaArray(raw, batch.length);
      } catch (e) {
        console.error(`[${model}] batch ${s / BATCH} failed:`, (e as { message?: string }).message ?? e);
      }
      batch.forEach((_, k) => {
        const p = parsed?.[k];
        rows.push({
          name: manifest[s + k].name,
          en: p?.en ? tidyCaption(p.en, subjects, MODE) : "",
          ja: p?.ja ?? "",
        });
      });
    }
    result[model] = rows;
    console.log(`[${model}] done: ${rows.filter((r) => r.en).length}/${rows.length} captioned`);
  }
  writeFileSync(outPath, JSON.stringify({ trigger, result }, null, 1), "utf8");
  console.log("wrote", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
