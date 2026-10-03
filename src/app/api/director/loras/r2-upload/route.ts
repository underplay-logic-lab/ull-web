import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  DIRECTOR_LORA_MAX_BYTES,
  DIRECTOR_LORA_PART_BYTES,
  directorLoraR2Key,
  isOwnedDirectorLoraR2Key,
} from "@/lib/directorLoraUpload.server";
import {
  completeR2Multipart,
  createR2Multipart,
  presignR2UploadPart,
  r2Enabled,
  r2UserRoot,
} from "@/lib/r2.server";

// Director の持ち込み LoRA を R2 へ分割・並行でアップロードする（2026-10-03）。
//   start    { filename, size }               → { key, uploadId, partBytes, partUrls[] }
//   complete { key, uploadId, parts[{partNumber, etag}] } → { key }
// バイトはブラウザ → R2 に直接流れ、ここは署名と完了の通知だけ（Vercel のボディ上限に触れない）。
export const maxDuration = 30;

export async function POST(request: Request) {
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  const { data: userData, error: userError } = await createClient(supabaseUrl, anonKey).auth.getUser(accessToken);
  if (userError || !userData?.user) return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  if (!r2Enabled()) return NextResponse.json({ error: "現在アップロードを受け付けていません。" }, { status: 503 });

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // 下の action チェックで弾く。
  }

  try {
    const root = await r2UserRoot(userData.user.id);

    if (body.action === "start") {
      const filename = typeof body.filename === "string" ? body.filename : "";
      const size = typeof body.size === "number" ? body.size : 0;
      if (!/\.safetensors$/i.test(filename)) {
        return NextResponse.json({ error: ".safetensors ファイルを選んでください。" }, { status: 400 });
      }
      if (!(size > 0) || size > DIRECTOR_LORA_MAX_BYTES) {
        return NextResponse.json({ error: "ファイルサイズが大きすぎます（上限2GB）。" }, { status: 400 });
      }
      const key = directorLoraR2Key(root, filename);
      const uploadId = await createR2Multipart(key, "application/octet-stream");
      const partCount = Math.ceil(size / DIRECTOR_LORA_PART_BYTES);
      const partUrls = await Promise.all(
        Array.from({ length: partCount }, (_, i) => presignR2UploadPart(key, uploadId, i + 1)),
      );
      return NextResponse.json({ key, uploadId, partBytes: DIRECTOR_LORA_PART_BYTES, partUrls });
    }

    if (body.action === "complete") {
      const key = typeof body.key === "string" ? body.key : "";
      const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
      const parts = Array.isArray(body.parts) ? (body.parts as { partNumber?: unknown; etag?: unknown }[]) : [];
      if (!isOwnedDirectorLoraR2Key(root, key) || !uploadId || parts.length === 0) {
        return NextResponse.json({ error: "アップロードの指定が不正です。" }, { status: 400 });
      }
      const clean = parts.map((p) => ({
        partNumber: typeof p.partNumber === "number" ? p.partNumber : 0,
        etag: typeof p.etag === "string" ? p.etag : "",
      }));
      if (clean.some((p) => p.partNumber < 1 || !p.etag)) {
        return NextResponse.json({ error: "アップロードの指定が不正です。" }, { status: 400 });
      }
      await completeR2Multipart(key, uploadId, clean);
      return NextResponse.json({ key });
    }

    return NextResponse.json({ error: "action が不正です。" }, { status: 400 });
  } catch (err) {
    console.error("[director/loras/r2-upload] failed:", err);
    return NextResponse.json({ error: "アップロードに失敗しました。もう一度お試しください。" }, { status: 500 });
  }
}
