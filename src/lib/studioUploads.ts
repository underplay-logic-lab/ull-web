import { supabase } from "@/lib/supabaseClient";

// Studio 全体（超解像・Multi-Angle・特化ワークフロー等）で共有する、入力
// ファイルの一時アップロード用 Storage バケット。ブラウザから直接ここへ
// アップロードし、Vercel サーバーレス関数のリクエストボディ上限（約4.5MB。
// CLAUDE.md §6）を回避する。API route には storage path だけを渡し、
// route 側は studioUploads.server.ts の各関数で service role として取得
// する。手本: src/lib/loraApi.ts の uploadLoraDataset。
//
// バケット名 "upscale-uploads" は超解像タブで最初に導入した際の名残 —
// 実際の用途は特定機能に限らない Studio 共通の一時アップロードなので、
// バケットを増やさずここへ集約している。
export const STUDIO_UPLOAD_BUCKET = "upscale-uploads";

export async function uploadStudioAsset(userId: string, file: File): Promise<{ path: string }> {
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "file";
  const path = `${userId}/${crypto.randomUUID()}-${safe}`;
  const { error } = await supabase.storage
    .from(STUDIO_UPLOAD_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || "application/octet-stream" });
  if (error) throw new Error(error.message);
  return { path };
}
