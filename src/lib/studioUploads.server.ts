import "server-only";
import { signStudioDownloadUrl, studioUploadLegacyR2Key, studioUploadR2Key } from "@/lib/studioUploadTicket.server";
import { deleteR2Keys, headR2, presignR2Get, r2Configured, uploadStore } from "@/lib/r2.server";

// 一時アップロード（studioUploads.ts の uploadStudioAsset で置かれたもの）を
// API route から取得・後片付けするための共通ヘルパー。5つの route
// （超解像 単発/バッチ/動画・Multi-Angle・特化ワークフロー・Director）で
// 同じ「userId 配下のパスか検証 → 取得/署名URL発行 → 使用後に削除」を個別に
// 書いていたのをここに集約した。
//
// 2026-09-19: Supabase Storage から Modal 直配信（modal_studio_uploads.py）
// へ移行（CLAUDE.md §1標準）。
// 2026-09-23: ブラウザ → R2 直 PUT へ移行（計画 4）。storagePath の形
// ("<userId>/<filename>") は変えず、読む側が「R2 にあれば R2、無ければ
// Modal（Volume）」と解決する。UPLOAD_STORE=volume で戻した直後や、切替を
// またいだアップロードでも壊れない。

export function assertOwnedPath(userId: string, storagePath: string): void {
  if (!storagePath.startsWith(`${userId}/`)) {
    throw new Error("不正なファイル指定です。");
  }
}

type Located = { store: "r2"; key: string } | { store: "modal" };

/** storagePath がどちらのストアにあるかを解決する。R2 の資格情報がある限り
 * HEAD 1 回で確認し（安価）、無ければ Modal 経路。HEAD 自体の失敗も Modal へ
 * 倒す（ストレージ層の不調でジョブを止めない）。 */
async function locateStudioUpload(userId: string, storagePath: string): Promise<Located> {
  assertOwnedPath(userId, storagePath);
  if (!r2Configured()) return { store: "modal" };
  const filename = storagePath.slice(userId.length + 1);
  // ユーザー別の配置（2026-09-24〜）→ 旧配置の順に探す。
  for (const key of [await studioUploadR2Key(userId, filename), studioUploadLegacyR2Key(userId, filename)]) {
    try {
      const size = await headR2(key);
      if (size !== null) return { store: "r2", key };
    } catch (err) {
      console.error("[studioUploads] R2 head failed, falling back to Modal:", key, err instanceof Error ? err.message : err);
      return { store: "modal" };
    }
  }
  return { store: "modal" };
}

/**
 * 先頭 `bytes` バイトだけを Range で取得し、ファイル全体のサイズと一緒に返す
 * （2026-09-24、超解像バッチの寸法読み取り用。全体を落とすと枚数が増えたときに
 * route の実行時間とメモリを食う）。Range を無視するストアでも全体が返るだけで
 * 結果は正しい。
 */
export async function readStudioUploadHead(
  userId: string,
  storagePath: string,
  bytes: number,
): Promise<{ head: Buffer; totalBytes: number | null }> {
  const located = await locateStudioUpload(userId, storagePath);
  const url =
    located.store === "r2"
      ? await presignR2Get(located.key, { expiresIn: 300 })
      : signStudioDownloadUrl(userId, storagePath);
  const res = await fetch(url, { headers: { Range: `bytes=0-${Math.max(1, bytes) - 1}` } });
  if (!res.ok) {
    console.error("[studioUploads] head read failed:", located.store, storagePath, res.status);
    throw new Error("アップロードされたファイルの取得に失敗しました。");
  }
  const head = Buffer.from(await res.arrayBuffer());
  const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
  const totalBytes = m ? Number(m[1]) : res.status === 200 ? head.length : null;
  return { head, totalBytes };
}

/** storagePath の中身を Buffer として取得する。失敗時は Error を throw する
 * ので、呼び出し側で catch して route ごとの文言・ステータスに変換する。 */
export async function downloadStudioUpload(userId: string, storagePath: string): Promise<Buffer> {
  const located = await locateStudioUpload(userId, storagePath);
  const url =
    located.store === "r2"
      ? await presignR2Get(located.key, { expiresIn: 300 })
      : signStudioDownloadUrl(userId, storagePath);
  const res = await fetch(url);
  if (!res.ok) {
    console.error("[studioUploads] download failed:", located.store, storagePath, res.status);
    throw new Error("アップロードされたファイルの取得に失敗しました。");
  }
  return Buffer.from(await res.arrayBuffer());
}

/** worker が直接 fetch できる署名付き URL を発行する（Vercel 関数がファイル
 * 本体を経由しない、より軽い経路。worker 側が URL 入力に対応している場合
 * のみ使う — 例: modal_seedvr2_worker.py の _load_input_bytes。R2 の URL は
 * ホスト `*.r2.cloudflarestorage.com` なので worker 側の許可リストに含める）。 */
export async function createStudioUploadSignedUrl(
  userId: string,
  storagePath: string,
  expiresInSeconds = 60 * 60,
): Promise<string> {
  const located = await locateStudioUpload(userId, storagePath);
  if (located.store === "r2") {
    return presignR2Get(located.key, { expiresIn: expiresInSeconds });
  }
  return signStudioDownloadUrl(userId, storagePath, expiresInSeconds);
}

/** ベストエフォート削除。読み終わった一時アップロードの後片付け用 —
 * 失敗してもジョブ自体には影響させない（fire-and-forget）。
 * R2 側は存在しないキーを消しても無害なので常に投げる。Modal 側の delete
 * エンドポイントはコンテナ起動を伴うため、UPLOAD_STORE=volume で運用している
 * とき（＝新規が Volume に書かれているとき）だけ呼ぶ。切替前の残りは
 * modal_retention_purge.py の 14 日パージが拾う。 */
export function deleteStudioUploads(paths: (string | null | undefined)[]): void {
  const clean = paths.filter((p): p is string => Boolean(p));
  if (clean.length === 0) return;

  if (r2Configured()) {
    void (async () => {
      const keys: string[] = [];
      for (const p of clean) {
        const slash = p.indexOf("/");
        if (slash <= 0) continue;
        const uid = p.slice(0, slash);
        keys.push(await studioUploadR2Key(uid, p.slice(slash + 1)), `studio_uploads/${p}`);
      }
      return deleteR2Keys(keys);
    })().catch((err) => {
      console.error("[studioUploads] R2 delete failed:", err instanceof Error ? err.message : err);
    });
  }

  if (r2Configured() && uploadStore() === "r2") return;

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
