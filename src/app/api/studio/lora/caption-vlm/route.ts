import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildVisionPrompt } from "@/lib/loraCaptionVision";
import { CONTENT_POLICY_BLOCK_MESSAGE } from "@/lib/contentPolicy";
import { finalizeRawSingles, parseCaptionRequest } from "@/lib/loraCaptionRequest.server";
import { presignR2Put, r2KeyForRel, r2UploadsEnabled } from "@/lib/r2.server";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { LORA_CAPTION_FREE_MAX, loraCaptionPrice } from "@/lib/loraCaptionSpec";
import { getOrCreateProfile } from "@/lib/profile";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// LoRA キャプション解析の自前 VLM 経路（2026-09-24、docs/gpu-benchmarks.md §17）。
// Gemini の route（../caption）は 4 枚ずつ画像本体を受けるが、こちらは全枚数をまとめて GPU に渡すので
// 画像は Vercel を通さず、ブラウザ → R2 へ直接 PUT する（CLAUDE.md §1 大容量バイナリの原則）。
//
//   { action: "start", count, mimes[] }             -> { jobId, uploads: [url] }
//   { action: "run",   jobId, mimes[], ...spec }    -> { ok }         （Modal に spawn）
//   { action: "status", jobId, ...spec }            -> { status, done, total, entries: [{ index, en, ja }] }
//
// spec（trigger_word / subjects / caption_prompt / category / caption_mode）は Gemini の route と同じで、
// 検証・指示文・整形は loraCaptionRequest.server.ts を共有する。
//
// 料金（2026-09-25 ホスト判断）: knob `lora_caption_base` + `lora_caption_per_image` × 枚数（既定 50C + 1C/枚）を run で
// 引き落とす。FREE_RETRY_MAX 枚以下（取りこぼしの再解析）は無料。Modal への受け渡しに失敗したらここで返し、
// 解析が失敗したら worker（modal_caption_worker.py）が返す。
export const maxDuration = 60;

const MAX_IMAGES = 500;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT_BY_MIME: Record<string, string> = { "image/webp": "webp", "image/jpeg": "jpg" };
const PUT_TTL_S = 15 * 60;
const FREE_RETRY_MAX = LORA_CAPTION_FREE_MAX;

/** 料金（クライアントの表示は loraCaptionPrice と同じ式）。5 枚以下の再解析は無料。 */
async function captionPrice(count: number): Promise<number> {
  if (count <= FREE_RETRY_MAX) return 0;
  const k = await getPricingKnobs();
  return loraCaptionPrice(count, k);
}

/** 有効な残高（期限切れは 0）。 */
async function currentCredits(userId: string): Promise<number | null> {
  const { data, error } = await getOrCreateProfile(userId, "credits, credits_expire_at");
  if (error) return null;
  const exp = data?.credits_expire_at as string | null | undefined;
  const expired = exp ? new Date(exp).getTime() < Date.now() : false;
  return expired ? 0 : ((data?.credits as number | null | undefined) ?? 0);
}

async function adjustCredits(userId: string, delta: number): Promise<boolean> {
  const cur = await currentCredits(userId);
  if (cur === null || cur + delta < 0) return false;
  const { error } = await supabaseAdmin.from("profiles").update({ credits: cur + delta }).eq("id", userId);
  if (error) console.error("[lora/caption-vlm] credit update failed:", error.message);
  return !error;
}

const DISPATCH_URL =
  process.env.MODAL_CAPTION_DISPATCH_URL || "https://axelbh5--ull-caption-worker-caption-dispatch.modal.run";
const STATUS_URL =
  process.env.MODAL_CAPTION_STATUS_URL || "https://axelbh5--ull-caption-worker-caption-status.modal.run";
const ABORT_URL =
  process.env.MODAL_CAPTION_ABORT_URL || "https://axelbh5--ull-caption-worker-caption-abort.modal.run";

async function modalStatus(dictKey: string, authToken: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${STATUS_URL}?dict_key=${encodeURIComponent(dictKey)}`, {
    headers: { "x-modal-secret": authToken },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

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
    // 送る前に残高を見ておく（アップロードしてから足りないと言われないように）。引き落としは run で行う。
    if (count > FREE_RETRY_MAX) {
      const price = await captionPrice(count);
      const cur = await currentCredits(userId);
      if (cur !== null && cur < price) {
        return NextResponse.json(
          { error: `クレジットが不足しています（キャプション作成は ${price}C）。チャージしてから再度お試しください。` },
          { status: 402 },
        );
      }
    }
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
    let price = await captionPrice(count);
    // 直前の有料の解析で取りこぼした画像のやり直しは無料（2026-09-25 ホスト判断）。サーバー側で、前回のジョブが
    // このユーザーのもので、読めなかった枚数以下であることを確かめる。
    const retryOf = typeof body?.retry_of === "string" && JOB_ID_RE.test(body.retry_of) ? body.retry_of : "";
    if (price > 0 && retryOf) {
      const prev = await modalStatus(`${userId}:${retryOf}`, authToken);
      const raws = Array.isArray(prev?.raws) ? (prev.raws as (string | null)[]) : [];
      const missed = finalizeRawSingles(raws, spec).captions.filter((c) => !c.trim()).length;
      if (prev?.status === "completed" && count <= missed) price = 0;
    }
    if (price > 0 && !(await adjustCredits(userId, -price))) {
      return NextResponse.json(
        { error: `クレジットが不足しています（キャプション作成は ${price}C）。チャージしてから再度お試しください。` },
        { status: 402 },
      );
    }
    const res = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
      body: JSON.stringify({
        dict_key: dictKey,
        keys,
        prompt,
        max_tokens: spec.captionMode === "dense" ? 700 : 400,
        // 解析が失敗したときに worker が返すための情報。
        user_id: userId,
        credits_cost: price,
      }),
    }).catch((err: unknown) => {
      console.error("[lora/caption-vlm] dispatch failed:", err);
      return null;
    });
    if (!res?.ok) {
      console.error("[lora/caption-vlm] dispatch status:", res?.status, await res?.text().catch(() => ""));
      if (price > 0) await adjustCredits(userId, price);
      return NextResponse.json({ error: "解析を開始できませんでした。時間をおいて再試行してください。" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, charged: price });
  }

  if (action === "abort") {
    // 解析が始まらないまま 3 分（GPU の起動・読み込みの失敗）→ 取り消して返金（worker 側で queued のときだけ）。
    const res = await fetch(ABORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
      body: JSON.stringify({ dict_key: dictKey }),
    }).catch(() => null);
    const data = res?.ok ? ((await res.json()) as { aborted?: boolean; status?: string }) : null;
    return NextResponse.json({ aborted: Boolean(data?.aborted), status: data?.status ?? null });
  }

  if (action === "status") {
    const raw = await modalStatus(dictKey, authToken);
    if (!raw) return NextResponse.json({ error: "解析の状態を取得できませんでした。" }, { status: 502 });
    const st = raw as {
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
