import "server-only";
import { signStudioDownloadUrl } from "@/lib/studioUploadTicket.server";

// 一時アップロード（studioUploads.ts の uploadStudioAsset で置かれたもの）を
// API route から取得・後片付けするための共通ヘルパー。5つの route
// （超解像 単発/バッチ/動画・Multi-Angle・特化ワークフロー・Director）で
// 同じ「userId 配下のパスか検証 → 取得/署名URL発行 → 使用後に削除」を個別に
// 書いていたのをここに集約した。
//
// 2026-09-19: Supabase Storage から Modal 直配信（modal_studio_uploads.py）
// へ移行（CLAUDE.md §1標準）。呼び出し側のシグネチャ・storagePath の形は
// 移行前と互換のまま。

export function assertOwnedPath(userId: string, storagePath: string): void {
  if (!storagePath.startsWith(`${userId}/`)) {
    throw new Error("不正なファイル指定です。");
  }
}

/** storagePath の中身を Buffer として取得する。失敗時は Error を throw する
 * ので、呼び出し側で catch して route ごとの文言・ステータスに変換する。 */
export async function downloadStudioUpload(userId: string, storagePath: string): Promise<Buffer> {
  assertOwnedPath(userId, storagePath);
  const url = signStudioDownloadUrl(userId, storagePath);
  const res = await fetch(url);
  if (!res.ok) {
    console.error("[studioUploads] download failed:", storagePath, res.status);
    throw new Error("アップロードされたファイルの取得に失敗しました。");
  }
  return Buffer.from(await res.arrayBuffer());
}

/** worker が直接 fetch できる署名付き URL を発行する（Vercel 関数がファイル
 * 本体を経由しない、より軽い経路。worker 側が URL 入力に対応している場合
 * のみ使う — 例: modal_seedvr2_worker.py の _load_input_bytes）。 */
export async function createStudioUploadSignedUrl(
  userId: string,
  storagePath: string,
  expiresInSeconds = 60 * 60,
): Promise<string> {
  assertOwnedPath(userId, storagePath);
  return signStudioDownloadUrl(userId, storagePath, expiresInSeconds);
}

/** ベストエフォート削除。読み終わった一時アップロードの後片付け用 —
 * 失敗してもジョブ自体には影響させない（fire-and-forget）。delete
 * エンドポイントはブラウザに公開していないので MODAL_AUTH_TOKEN の単純
 * Bearer 認証（modal_studio_uploads.py::_authorize_server）。 */
export function deleteStudioUploads(paths: (string | null | undefined)[]): void {
  const clean = paths.filter((p): p is string => Boolean(p));
  if (clean.length === 0) return;
  const deleteUrl = process.env.MODAL_STUDIO_DELETE_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!deleteUrl || !authToken) {
    console.error("[studioUploads] delete skipped: MODAL_STUDIO_DELETE_URL/MODAL_AUTH_TOKEN not set");
    return;
  }
  const volumePaths = clean.map((p) => `studio_uploads/${p}`);
  void fetch(deleteUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ paths: volumePaths }),
  }).catch((err) => {
    console.error("[studioUploads] delete request failed:", err instanceof Error ? err.message : err);
  });
}
