import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// ULL Cinematic Director: ユーザーが外部で用意した .safetensors を持ち込んで
// 適用する経路（2026-09-18追加）。director-user-loras バケット（private、
// "<user_id>/<uuid>-<filename>" 配下）に対する所有権チェック＋署名付きURL
// 発行。studioUploads.server.ts の assertOwnedPath / createStudioUploadSignedUrl
// と同じパターンだが、バケットが異なるため別ファイルに分離した。
//
// LoRA Studio 学習済みLoRA（Volume常駐、14日パージ対象）とは別物 —— こちらは
// 「生成物」ではなくユーザーが持ち込む「入力データ」なので期限を設けない。

export const DIRECTOR_USER_LORA_BUCKET = "director-user-loras";

export function assertOwnedDirectorLoraPath(userId: string, storagePath: string): void {
  if (!storagePath.startsWith(`${userId}/`)) {
    throw new Error("不正なファイル指定です。");
  }
}

/** modal_wan_animate_blackwell.py が直接ダウンロードできる署名付きURLを発行する。
 * Vercel関数はファイル本体（数百MB〜数GB）を経由しない。 */
export async function createDirectorLoraSignedUrl(
  userId: string,
  storagePath: string,
  expiresInSeconds = 60 * 30,
): Promise<string> {
  assertOwnedDirectorLoraPath(userId, storagePath);
  const { data, error } = await supabaseAdmin.storage
    .from(DIRECTOR_USER_LORA_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data?.signedUrl) {
    console.error("[directorLoraUpload] sign failed:", storagePath, error?.message);
    throw new Error("アップロードされたLoRAファイルの取得に失敗しました。");
  }
  return data.signedUrl;
}
