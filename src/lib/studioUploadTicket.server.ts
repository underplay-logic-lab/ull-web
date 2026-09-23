import "server-only";
import crypto from "crypto";
import { presignR2Put, r2UploadsEnabled } from "@/lib/r2.server";

// studioUploads.ts/.server.ts が使う、一時アップロード用チケットの発行ヘルパー。
//
// 2026-09-23（R2 移行 計画 4）: 既定ではブラウザが R2 へ直接 PUT する署名付き
// URL を返す（store: "r2"）。`UPLOAD_STORE=volume`（または R2 未設定）のときは
// 従来どおり modal_studio_uploads.py::upload への HMAC チケット（store: "modal"、
// 鍵: MODAL_AUTH_TOKEN）。どちらも呼び出し側が受け取る `path` は
// "<userId>/<filename>" のまま — 各 route の assertOwnedPath 等は無改修。
//
// R2 のキーは Volume の相対パスと同じ `studio_uploads/<userId>/<filename>`。
// 署名付き PUT は host しか署名しない（2026-09-23 実測、SignedHeaders=host）ので、
// ブラウザは Content-Type を自由に付けてよい。

const TICKET_TTL_SECONDS = 60 * 10; // 10分（大きめの動画アップロードでも間に合うよう余裕を持たせる）
const R2_PUT_TTL_SECONDS = 60 * 30; // R2 直 PUT は 1GB 級の動画も 1 本で送るので長めに
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]{1,140}$/;
// modal_studio_uploads.py::UPLOAD_MAX_BYTES と同じ安全弁。R2 経路はサーバーが
// 受信しないので、チケット発行時の申告サイズで弾く（route 側にも各自の上限あり）。
export const STUDIO_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024; // 1GB

function sign(userId: string, filename: string, expiresAt: number): string {
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!authToken) throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  return crypto
    .createHmac("sha256", authToken)
    .update(`studio-upload:${userId}:${filename}:${expiresAt}`)
    .digest("hex");
}

export function studioUploadR2Key(userId: string, filename: string): string {
  return `studio_uploads/${userId}/${filename}`;
}

export type StudioUploadTicket =
  | {
      store: "r2";
      method: "PUT";
      /** 署名付き PUT URL。ブラウザはここへファイル本体をそのまま送る。 */
      uploadUrl: string;
      userId: string;
      filename: string;
      path: string;
      expiresAt: number;
    }
  | {
      store: "modal";
      method: "POST";
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

export async function createStudioUploadTicket(
  userId: string,
  filename: string,
  opts: { sizeBytes?: number } = {},
): Promise<StudioUploadTicket> {
  if (!SAFE_FILENAME_RE.test(filename)) {
    throw new Error("不正なファイル名です。");
  }
  if (typeof opts.sizeBytes === "number" && opts.sizeBytes > STUDIO_UPLOAD_MAX_BYTES) {
    throw new Error("ファイルが大きすぎます（上限 1GB）。");
  }
  const path = `${userId}/${filename}`;

  if (r2UploadsEnabled()) {
    const expiresAt = Math.floor(Date.now() / 1000) + R2_PUT_TTL_SECONDS;
    const uploadUrl = await presignR2Put(studioUploadR2Key(userId, filename), {
      expiresIn: R2_PUT_TTL_SECONDS,
    });
    return { store: "r2", method: "PUT", uploadUrl, userId, filename, path, expiresAt };
  }

  const uploadUrl = process.env.MODAL_STUDIO_UPLOAD_URL;
  if (!uploadUrl) {
    throw new Error("MODAL_STUDIO_UPLOAD_URL が未設定です（modal_studio_uploads.py の upload のURL）。");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const sig = sign(userId, filename, expiresAt);
  return { store: "modal", method: "POST", uploadUrl, userId, filename, path, expiresAt, sig };
}

/** "<userId>/<filename>" 形式の storagePath から、Modal を直接叩ける
 * 署名付きダウンロードURLを組み立てる（Volume 側にあるファイル用）。 */
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
