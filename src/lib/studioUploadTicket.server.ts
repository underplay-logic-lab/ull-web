import "server-only";
import crypto from "crypto";

// studioUploads.ts/.server.ts が使う、Modal直アップロード/配信/削除の署名付き
// URL発行ヘルパー（2026-09-19導入、CLAUDE.md §1標準の適用）。HMAC方式は
// modal_studio_uploads.py::_verify_token と共通（鍵: MODAL_AUTH_TOKEN、
// modal_lora_worker.py::upload_user_lora と同じ手法）。

const TICKET_TTL_SECONDS = 60 * 10; // 10分（大きめの動画アップロードでも間に合うよう余裕を持たせる）
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]{1,140}$/;

function sign(userId: string, filename: string, expiresAt: number): string {
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!authToken) throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  return crypto
    .createHmac("sha256", authToken)
    .update(`studio-upload:${userId}:${filename}:${expiresAt}`)
    .digest("hex");
}

export type StudioUploadTicket = {
  uploadUrl: string;
  userId: string;
  filename: string;
  /** 呼び出し側が storagePath として扱う値。"<userId>/<filename>" 形式を
   * 維持しているのは、既存route側の assertOwnedPath 等のチェックを一切
   * 変更せずに済ませるため（Modal側の実パスは studio_uploads/ 配下）。 */
  path: string;
  expiresAt: number;
  sig: string;
};

export function createStudioUploadTicket(userId: string, filename: string): StudioUploadTicket {
  if (!SAFE_FILENAME_RE.test(filename)) {
    throw new Error("不正なファイル名です。");
  }
  const uploadUrl = process.env.MODAL_STUDIO_UPLOAD_URL;
  if (!uploadUrl) {
    throw new Error("MODAL_STUDIO_UPLOAD_URL が未設定です（modal_studio_uploads.py の upload のURL）。");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const sig = sign(userId, filename, expiresAt);
  return { uploadUrl, userId, filename, path: `${userId}/${filename}`, expiresAt, sig };
}

/** "<userId>/<filename>" 形式の storagePath から、Modal を直接叩ける
 * 署名付きダウンロードURLを組み立てる。 */
export function signStudioDownloadUrl(
  userId: string,
  storagePath: string,
  expiresInSeconds = 60 * 60,
): string {
  if (!storagePath.startsWith(`${userId}/`)) {
    throw new Error("不正なファイル指定です。");
  }
  const filename = storagePath.slice(userId.length + 1);
  const downloadUrl = process.env.MODAL_STUDIO_DOWNLOAD_URL;
  if (!downloadUrl) {
    throw new Error("MODAL_STUDIO_DOWNLOAD_URL が未設定です（modal_studio_uploads.py の download のURL）。");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const sig = sign(userId, filename, expiresAt);
  const url = new URL(downloadUrl);
  url.searchParams.set("user_id", userId);
  url.searchParams.set("filename", filename);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("sig", sig);
  return url.toString();
}
