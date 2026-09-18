import "server-only";
import crypto from "crypto";

// ULL Cinematic Director: ユーザーが外部で用意した .safetensors を持ち込んで
// 適用する経路（2026-09-18導入・同日中に設計変更）。
//
// 当初 Supabase Storage 経由（ブラウザ→Storage→Modalがダウンロード）だった
// が、Supabase Freeプランのグローバルアップロード上限（プロジェクト全体で
// 50MB固定・バケット単位のfile_size_limitとは別物で引き上げ不可）に阻まれ、
// 実運用サイズのLoRA（rank32のminimax_h3で約1.18GB）を通せないことが実機で
// 判明し撤回。ブラウザから modal_lora_worker.py の upload_user_lora
// エンドポイントへ直接アップロードする方式に変更した——Vercel/Supabaseの
// どちらも経由しないので、双方のボディサイズ上限にもSupabaseの月間転送量
// クォータにも一切影響しない。
//
// このファイルは、その直接アップロードを許可するための短命の署名付き
// トークン（HMAC-SHA256、MODAL_AUTH_TOKEN を鍵に upload:user_id:filename:
// expires_at を署名）を発行する。共有シークレット自体はブラウザに渡さない
// （modal_lora_worker.py::_verify_upload_token と同じ方式、
// download_lora_checkpointの署名方式のアップロード版）。

const UPLOAD_TOKEN_TTL_SECONDS = 60 * 10; // 10分（大きめのファイルでもアップロードが間に合うよう余裕を持たせる）
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]{1,120}\.safetensors$/;

export type DirectorLoraUploadTicket = {
  uploadUrl: string;
  /** 中断からの再開用ステータス確認エンドポイント（2026-09-19導入）。
   * upload_user_loraと同じ署名を使い回せる（HTTPメソッドは署名対象外）。 */
  statusUrl: string;
  userId: string;
  filename: string;
  volumePath: string;
  expiresAt: number;
  sig: string;
};

/** アップロード先ファイル名を発行し、署名付きアップロードチケットを返す。
 * filename は呼び出し側（クライアント）が生成した決定的な名前
 * "<size>-<lastModified>-<safeName>.safetensors" をそのまま受け取る想定
 * （2026-09-19、乱数UUIDから変更 — 同じファイルを選び直せば毎回同じ名前に
 * なるため、ブラウザを閉じて再開しても director_lora_upload_status で
 * 前回の続きを検出できる）。 */
export function createDirectorLoraUploadTicket(userId: string, filename: string): DirectorLoraUploadTicket {
  if (!SAFE_FILENAME_RE.test(filename)) {
    throw new Error("不正なファイル名です。");
  }
  const uploadUrl = process.env.MODAL_LORA_UPLOAD_URL;
  const statusUrl = process.env.MODAL_LORA_UPLOAD_STATUS_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!uploadUrl) {
    throw new Error("MODAL_LORA_UPLOAD_URL が未設定です（modal_lora_worker.py の upload_user_lora のURL）。");
  }
  if (!statusUrl) {
    throw new Error("MODAL_LORA_UPLOAD_STATUS_URL が未設定です（modal_lora_worker.py の director_lora_upload_status のURL）。");
  }
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", authToken)
    .update(`upload:${userId}:${filename}:${expiresAt}`)
    .digest("hex");
  return {
    uploadUrl,
    statusUrl,
    userId,
    filename,
    volumePath: `director_user_loras/${userId}/${filename}`,
    expiresAt,
    sig,
  };
}

/** クライアントが生成完了後に返してくる Volume相対パスが本人のものである
 * ことを確認する。他人の user_id を騙って渡されても弾く。 */
export function assertOwnedDirectorLoraVolumePath(userId: string, volumePath: string): void {
  if (!volumePath.startsWith(`director_user_loras/${userId}/`)) {
    throw new Error("不正なLoRA指定です。");
  }
}
