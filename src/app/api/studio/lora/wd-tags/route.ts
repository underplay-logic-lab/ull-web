import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { presignR2Put, r2KeyForRel, r2UploadsEnabled } from "@/lib/r2.server";

// LoRA Studio の構図診断用タグ付け（2026-09-25、modal_wd_tagger.py）。無料・CPU。
// キャプション（有料）より前に、距離・向き・仰角・姿勢・背景を判定する材料を作る。
// 画像は caption-vlm と同じく縮小してブラウザ → R2 へ直接 PUT する（Vercel を通さない）。
//
//   { action: "start", count, mimes[] } -> { jobId, uploads: [url] }
//   { action: "run",   jobId, mimes[] } -> { ok }
//   { action: "status", jobId }         -> { status, done, total, entries: [{ index, tags }] }
export const maxDuration = 60;

const MAX_IMAGES = 500;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT_BY_MIME: Record<string, string> = { "image/webp": "webp", "image/jpeg": "jpg" };
const PUT_TTL_S = 15 * 60;

const DISPATCH_URL =
  process.env.MODAL_WD_TAG_DISPATCH_URL || "https://axelbh5--ull-wd-tagger-tag-dispatch.modal.run";
const STATUS_URL = process.env.MODAL_WD_TAG_STATUS_URL || "https://axelbh5--ull-wd-tagger-tag-status.modal.run";

function inputKeyRel(userId: string, jobId: string, i: number, mime: string): string {
  return `lora_wd_inputs/${userId}/${jobId}/${String(i).padStart(4, "0")}.${EXT_BY_MIME[mime] ?? "jpg"}`;
}

function parseMimes(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_IMAGES) return null;
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
    if (!r2UploadsEnabled()) return NextResponse.json({ error: "診断サーバーが利用できません。" }, { status: 503 });
    const mimes = parseMimes(body?.mimes);
    if (!mimes) return NextResponse.json({ error: `一度に診断できるのは ${MAX_IMAGES} 枚までです。` }, { status: 400 });
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

  if (action === "run") {
    const mimes = parseMimes(body?.mimes);
    if (!mimes) return NextResponse.json({ error: "画像の形式が不正です。" }, { status: 400 });
    const keys = await Promise.all(mimes.map((mime, i) => r2KeyForRel(inputKeyRel(userId, jobId, i, mime), userId)));
    const res = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-modal-secret": authToken },
      body: JSON.stringify({ dict_key: dictKey, keys }),
    }).catch(() => null);
    if (!res?.ok) {
      console.error("[lora/wd-tags] dispatch status:", res?.status, await res?.text().catch(() => ""));
      return NextResponse.json({ error: "診断を開始できませんでした。時間をおいて再試行してください。" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "status") {
    const res = await fetch(`${STATUS_URL}?dict_key=${encodeURIComponent(dictKey)}`, {
      headers: { "x-modal-secret": authToken },
      cache: "no-store",
    }).catch(() => null);
    if (!res?.ok) return NextResponse.json({ error: "診断の状態を取得できませんでした。" }, { status: 502 });
    const st = (await res.json()) as { status?: string; done?: number; total?: number; tags?: (string | null)[] };
    const tags = Array.isArray(st.tags) ? st.tags : [];
    return NextResponse.json({
      status: st.status ?? "unknown",
      done: st.done ?? 0,
      total: st.total ?? 0,
      entries: tags
        .map((t, index) => ({ index, tags: t }))
        .filter((e): e is { index: number; tags: string } => typeof e.tags === "string"),
      error: st.status === "failed" ? "構図の診断に失敗しました。時間をおいて再試行してください。" : undefined,
    });
  }

  return NextResponse.json({ error: "不明な操作です。" }, { status: 400 });
}
