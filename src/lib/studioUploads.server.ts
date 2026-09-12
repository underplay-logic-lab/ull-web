import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { STUDIO_UPLOAD_BUCKET } from "@/lib/studioUploads";

// 一時アップロード（studioUploads.ts の uploadStudioAsset で置かれたもの）を
// API route から取得・後片付けするための共通ヘルパー。5つの route
// （超解像 単発/バッチ/動画・Multi-Angle・特化ワークフロー）で同じ
// 「userId 配下のパスか検証 → service role で取得/署名URL発行 → 使用後に
// 削除」を個別に書いていたのをここに集約した。
//
// supabaseAdmin は service role で RLS を無視するため、assertOwnedPath の
// チェックを必ず経由すること（他ユーザーの storage path を渡されても読め
// てしまう）。

export function assertOwnedPath(userId: string, storagePath: string): void {
  if (!storagePath.startsWith(`${userId}/`)) {
    throw new Error("不正なファイル指定です。");
  }
}

/** storagePath の中身を Buffer として取得する。失敗時は Error を throw する
 * ので、呼び出し側で catch して route ごとの文言・ステータスに変換する。 */
export async function downloadStudioUpload(userId: string, storagePath: string): Promise<Buffer> {
  assertOwnedPath(userId, storagePath);
  const { data, error } = await supabaseAdmin.storage.from(STUDIO_UPLOAD_BUCKET).download(storagePath);
  if (error || !data) {
    console.error("[studioUploads] download failed:", storagePath, error?.message);
    throw new Error("アップロードされたファイルの取得に失敗しました。");
  }
  return Buffer.from(await data.arrayBuffer());
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
  const { data, error } = await supabaseAdmin.storage
    .from(STUDIO_UPLOAD_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data?.signedUrl) {
    console.error("[studioUploads] sign failed:", storagePath, error?.message);
    throw new Error("アップロードされたファイルの取得に失敗しました。");
  }
  return data.signedUrl;
}

/** ベストエフォート削除。読み終わった一時アップロードの後片付け用 —
 * 失敗してもジョブ自体には影響させない（fire-and-forget）。 */
export function deleteStudioUploads(paths: (string | null | undefined)[]): void {
  const clean = paths.filter((p): p is string => Boolean(p));
  if (clean.length === 0) return;
  void supabaseAdmin.storage.from(STUDIO_UPLOAD_BUCKET).remove(clean);
}
