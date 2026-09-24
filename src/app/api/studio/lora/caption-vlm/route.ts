import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildVisionPrompt } from "@/lib/loraCaptionVision";
import { CONTENT_POLICY_BLOCK_MESSAGE } from "@/lib/contentPolicy";
import { finalizeRawSingles, parseCaptionRequest } from "@/lib/loraCaptionRequest.server";
import { presignR2Put, r2KeyForRel, r2UploadsEnabled } from "@/lib/r2.server";

// LoRA キャプション解析の自前 VLM 経路（2026-09-24、docs/gpu-benchmarks.md §17）。
// Gemini の route（../caption）は 4 枚ずつ画像本体を受けるが、こちらは全枚数をまとめて GPU に渡すので
// 画像は Vercel を通さず、ブラウザ → R2 へ直接 PUT する（CLAUDE.md §1 大容量バイナリの原則）。
//
//   { action: "start", count, mimes[] }             -> { jobId, uploads: [url] }
//   { action: "run",   jobId, mimes[], ...spec }    -> { ok }         （Modal に spawn）
//   { action: "status", jobId, ...spec }            -> { status, done, total, entries: [{ index, en, ja }] }
//
// spec（trigger_word / subjects / caption_prompt / category / caption_mode）は Gemini の route と同じで、
// 検証・指示文・整形は loraCaptionRequest.server.ts を共有する。料金は未定（knob で後から入れる）。
export const maxDuration = 60;

const MAX_IMAGES = 500;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT_BY_MIME: Record<string, string> = { "image/webp": "webp", "image/jpeg": "jpg" };
const PUT_TTL_S = 15 * 60;

const DISPATCH_URL =
  process.env.MODAL_CAPTION_DISPATCH_URL || "https://axelbh5--ull-caption-worker-caption-dispatch.modal.run";
const STATUS_URL =
  process.env.MODAL_CAPTION_STATUS_URL || "https://axelbh5--ull-caption-worker-caption-status.modal.run";

function inputKeyRel(userId: string, jobId: string, i: number, mime: string): string {
  return `lora_caption_inputs/${userId}/${jobId}/${String(i).padStart(4, "0")}.${EXT_BY_MIME[mime] ?? "jpg"}`;
}

function parseMimes(raw: unknown, count: number): string[] | null {
  if (!Array.isArray(raw) || raw.length !== count) return null;
  const out = raw.map((m) => (typeof m === "string" && EXT_BY_MIME[m] ? m : ""));
  return out.every(Boolean) ? out : null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!supabaseUrl || !anonKey || !authToken) {
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }
  const { data: userData, error: userError } = await createClient(supabaseUrl, anonKey).auth.getUser(accessToken);
  if (userError || !userData?.user) return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  const userId = userData.user.id;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;

  if (action === "start") {
    if (!r2UploadsEnabled()) {
      return NextResponse.json({ error: "解析サーバーが利用できません。" }, { status: 503 });
    }
    const count = Number(body?.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) {
      return NextResponse.json({ error: `一度に解析できるのは ${MAX_IMAGES} 枚までです。` }, { status: 400 });
    }
    const mimes = parseMimes(body?.mimes, count);
    if (!mimes) return NextResponse.json({ error: "画像の形式が不正です。" }, { status: 400 });
    const jobId = crypto.randomUUID();
    const uploads = await Promise.all(
      mimes.map(async (mime, i) =>
        presignR2Put(await r2KeyForRel(inputKeyRel(userId, jobId, i, mime), userId), {
          expiresIn: PUT_TTL_S,
          contentType: mime,
        }),
      ),
    );
    return NextResponse.json({ jobId, uploads });
  }

  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  if (!JOB_ID_RE.test(jobId)) return NextResponse.json({ error: "不正なジョブです。" }, { status: 400 });
  // ユーザーをキーに含めるので、他人のジョブの状態は引けない。
  const dictKey = `${userId}:${jobId}`;
  const req = parseCaptionRequest(body, userId, "lora/caption-vlm");
  if (req.blocked) return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  const spec = req.spec;

  if (action === "run") {
    const count = Array.isArray(body?.mimes) ? body.mimes.length : 0;
    const mimes = parseMimes(body?.mimes, count);
    if (!mimes || count < 1 || count > MAX_IMAGES) {
      return NextResponse.json({ error: "画像の形式が不正です。" }, { status: 400 });
    }
    const keys = await Promise.all(mimes.map((mime, i) => r2KeyForRel(inputKeyRel(userId, jobId, i, mime), userId)));
    const prompt = buildVisionPrompt(1, spec.subjects, spec.captionPrompt, spec.captionMode);
    const res = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
      body: JSON.stringify({ dict_key: dictKey, keys, prompt, max_tokens: spec.captionMode === "dense" ? 700 : 400 }),
    }).catch((err: unknown) => {
      console.error("[lora/caption-vlm] dispatch failed:", err);
      return null;
    });
    if (!res?.ok) {
      console.error("[lora/caption-vlm] dispatch status:", res?.status, await res?.text().catch(() => ""));
      return NextResponse.json({ error: "解析を開始できませんでした。時間をおいて再試行してください。" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "status") {
    const res = await fetch(`${STATUS_URL}?dict_key=${encodeURIComponent(dictKey)}`, {
      headers: { "x-modal-secret": authToken },
      cache: "no-store",
    }).catch(() => null);
    if (!res?.ok) return NextResponse.json({ error: "解析の状態を取得できませんでした。" }, { status: 502 });
    const st = (await res.json()) as {
      status?: string;
      done?: number;
      total?: number;
      raws?: (string | null)[];
      error?: string;
    };
    const raws = Array.isArray(st.raws) ? st.raws : [];
    const { captions, captionsJa } = finalizeRawSingles(raws, spec);
    const entries = raws
      .map((raw, index) => ({ index, raw, en: captions[index], ja: captionsJa[index] }))
      .filter((e) => typeof e.raw === "string")
      .map(({ index, en, ja }) => ({ index, en, ja }));
    return NextResponse.json({
      status: st.status ?? "unknown",
      done: st.done ?? 0,
      total: st.total ?? 0,
      entries,
      error: st.status === "failed" ? "解析に失敗しました。時間をおいて再試行してください。" : undefined,
    });
  }

  return NextResponse.json({ error: "不明な操作です。" }, { status: 400 });
}
