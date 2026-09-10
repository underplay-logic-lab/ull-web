import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// admin「生成物 & ストレージ」タブのサーバー側ヘルパー。
// 生成成果物は 3 つの Supabase Storage バケットに散らばっている:
//   angle-results   (public)  … Multi-Angle 出力  <uid>/<job>/NN.png
//   upscale-results (public)  … 超解像 出力       <uid>/<job>.webp
//   lora_datasets   (private) … LoRA 学習データ   <uid>/<dataset>/...
// いずれも先頭セグメントが user_id。

export const GENERATED_BUCKETS = [
  { id: "angle-results", label: "Multi-Angle 出力", public: true },
  { id: "upscale-results", label: "超解像 出力", public: true },
  { id: "lora_datasets", label: "LoRA データセット", public: false },
] as const;

export type GeneratedBucketId = (typeof GENERATED_BUCKETS)[number]["id"];

export function isGeneratedBucket(id: string): id is GeneratedBucketId {
  return GENERATED_BUCKETS.some((b) => b.id === id);
}

export function bucketMeta(id: string) {
  return GENERATED_BUCKETS.find((b) => b.id === id) ?? null;
}

export type StorageEntry = {
  /** ディレクトリ内での名前（末尾セグメント）。 */
  name: string;
  /** バケットルートからの相対パス。 */
  path: string;
  isFolder: boolean;
  sizeBytes: number | null;
  updatedAt: string | null;
  mimeType: string | null;
};

const PAGE_SIZE = 1000;

/**
 * 1 プレフィックス（= 1 ディレクトリ階層）の直下のエントリを列挙する。
 * Supabase の list はページングが要るので全ページ回収する。
 */
export async function listPrefix(
  bucket: GeneratedBucketId,
  prefix: string,
): Promise<StorageEntry[]> {
  const clean = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  const out: StorageEntry[] = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin.storage.from(bucket).list(clean, {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const item of data) {
      // Supabase: フォルダは id === null。ファイルは metadata に size/mimetype。
      const isFolder = item.id === null;
      const p = clean ? `${clean}/${item.name}` : item.name;
      out.push({
        name: item.name,
        path: p,
        isFolder,
        sizeBytes: isFolder ? null : (item.metadata?.size ?? null),
        updatedAt: item.updated_at ?? item.created_at ?? null,
        mimeType: isFolder ? null : (item.metadata?.mimetype ?? null),
      });
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // フォルダ→ファイル、名前昇順。
  out.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** プレフィックス配下の全ファイルパスを再帰列挙（削除・集計用）。 */
export async function listAllFiles(
  bucket: GeneratedBucketId,
  prefix: string,
  cap = 5000,
): Promise<{ path: string; sizeBytes: number }[]> {
  const files: { path: string; sizeBytes: number }[] = [];
  const stack = [prefix];
  while (stack.length && files.length < cap) {
    const cur = stack.pop() as string;
    const entries = await listPrefix(bucket, cur);
    for (const e of entries) {
      if (e.isFolder) stack.push(e.path);
      else files.push({ path: e.path, sizeBytes: e.sizeBytes ?? 0 });
    }
  }
  return files;
}

export function publicUrl(bucket: GeneratedBucketId, path: string): string {
  return supabaseAdmin.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export async function signedUrl(
  bucket: GeneratedBucketId,
  path: string,
  expiresInSec = 600,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSec);
  if (error || !data) return null;
  return data.signedUrl;
}

/** ファイル/フォルダを削除。フォルダなら配下を再帰的に。返り値は削除件数。 */
export async function removePath(
  bucket: GeneratedBucketId,
  path: string,
  isFolder: boolean,
): Promise<number> {
  const targets = isFolder
    ? (await listAllFiles(bucket, path)).map((f) => f.path)
    : [path];
  if (targets.length === 0) return 0;

  let removed = 0;
  for (let i = 0; i < targets.length; i += 100) {
    const chunk = targets.slice(i, i + 100);
    const { error } = await supabaseAdmin.storage.from(bucket).remove(chunk);
    if (error) throw new Error(error.message);
    removed += chunk.length;
  }
  return removed;
}

/** 各バケット直下（= user_id フォルダ数）とざっくり容量。トップ画面のサマリー用。 */
export async function bucketSummaries() {
  const rows = await Promise.all(
    GENERATED_BUCKETS.map(async (b) => {
      try {
        const top = await listPrefix(b.id, "");
        return { bucket: b.id, label: b.label, folders: top.filter((e) => e.isFolder).length, files: top.filter((e) => !e.isFolder).length };
      } catch {
        return { bucket: b.id, label: b.label, folders: 0, files: 0, error: true };
      }
    }),
  );
  return rows;
}
