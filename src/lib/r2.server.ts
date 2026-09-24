import "server-only";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Cloudflare R2 artifact store — server-side twin of ull_r2.py.
//
// Workers upload finished artifacts (LoRA checkpoints, dataset.zip, …) to R2
// and stamp `r2_key` on the matching generation_jobs.metadata entry. The
// Next.js routes here mint short-lived presigned GET URLs for those keys, so
// bytes flow browser<->R2 directly at 34〜46 MB/s (docs/gpu-benchmarks.md
// §16.5) instead of through a Modal endpoint at 3〜7 MB/s.
//
// Env (Vercel + .env.local): R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
// R2_SECRET_ACCESS_KEY / R2_BUCKET. ARTIFACT_STORE=volume disables the R2
// path on the Next side (routes then ignore r2_key and use Modal) — the
// rollback knob named in docs/STATUS.md.

// `studio_uploads` / `lora_dataset_uploads` are the user-supplied inputs
// (migration plan step 4, 2026-09-23): the browser PUTs them straight to R2
// with a presigned URL and the workers read them back by the same key. The
// kind names equal the Volume sub-directories so a `<userId>/<file>`
// storagePath maps to `<kind>/<userId>/<file>` on both stores.
export type R2ArtifactKind = "loras" | "upscale" | "director" | "angle" | "studio_uploads" | "lora_dataset_uploads";

const DEFAULT_GET_TTL_S = 900; // 15 min — same as the Modal signed-link TTL

let cached: S3Client | null = null;

export function artifactStore(): "r2" | "volume" {
  return (process.env.ARTIFACT_STORE ?? "r2").trim().toLowerCase() === "volume" ? "volume" : "r2";
}

export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );
}

export function r2Enabled(): boolean {
  return artifactStore() === "r2" && r2Configured();
}

// User uploads (step 4) get their own override so they can be rolled back to
// the Modal endpoints without touching finished-artifact delivery:
// UPLOAD_STORE=volume. Unset → follows ARTIFACT_STORE.
export function uploadStore(): "r2" | "volume" {
  const v = (process.env.UPLOAD_STORE ?? "").trim().toLowerCase();
  if (v === "volume" || v === "modal") return "volume";
  if (v === "r2") return "r2";
  return artifactStore();
}

export function r2UploadsEnabled(): boolean {
  return uploadStore() === "r2" && r2Configured();
}

export function r2Bucket(): string {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error("R2 is not configured (missing R2_BUCKET).");
  return b;
}

export function r2Client(): S3Client {
  if (cached) return cached;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 is not configured (missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).");
  }
  cached = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return cached;
}

// Per-user key layout (2026-09-24, ホスト要望): `<email>_<user_id[:8]>/<kind>/…`
// so the bucket's top level lists users by e-mail in rclone / Explorer. Keep
// in sync with user_root() / key_for_rel() in ull_r2.py (same sanitising and
// fallback). Before this the key was the Volume-relative path itself
// (`<kind>/<user_id>/…`); readers therefore never recompute a key from a path
// — they use the stamped `r2_key` / `r2_key_map`.
const userRootCache = new Map<string, string>();

function sanitizeLabel(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, "_").slice(0, 120);
}

export async function r2UserRoot(userId: string): Promise<string> {
  const hit = userRootCache.get(userId);
  if (hit) return hit;
  const { data, error } = await supabaseAdmin.from("profiles").select("email").eq("id", userId).maybeSingle();
  if (error) {
    console.error("[r2] user root lookup failed:", userId.slice(0, 8), error.message);
    return `nomail_${userId}`; // not cached: retry next time
  }
  const label = sanitizeLabel(typeof data?.email === "string" ? data.email : "");
  const root = label ? `${label}_${userId.slice(0, 8)}` : `nomail_${userId}`;
  userRootCache.set(userId, root);
  return root;
}

/** Volume-relative `<kind>/<user_id>/<rest>` -> `<root>/<kind>/<rest>`. */
export async function r2KeyForRel(relPath: string, userId: string): Promise<string> {
  const parts = relPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length >= 2 && parts[1] === userId) parts.splice(1, 1);
  return [await r2UserRoot(userId), ...parts].join("/");
}

// Defensive key check for anything that came out of a DB row: no leading
// slash, no traversal, printable ASCII only (`@` / `+` for the e-mail root).
const SAFE_KEY_RE = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+\/-]{0,511}$/;
export function isSafeR2Key(key: unknown): key is string {
  return typeof key === "string" && SAFE_KEY_RE.test(key) && !key.split("/").includes("..");
}

function contentDisposition(downloadName: string): string {
  // RFC 6266: ASCII fallback + UTF-8 form so non-ASCII names survive.
  const ascii = downloadName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
}

export async function presignR2Get(
  key: string,
  opts: { expiresIn?: number; downloadName?: string; contentType?: string } = {},
): Promise<string> {
  if (!isSafeR2Key(key)) throw new Error("invalid R2 key");
  const cmd = new GetObjectCommand({
    Bucket: r2Bucket(),
    Key: key,
    ResponseContentDisposition: opts.downloadName ? contentDisposition(opts.downloadName) : undefined,
    ResponseContentType: opts.contentType,
  });
  return getSignedUrl(r2Client(), cmd, { expiresIn: opts.expiresIn ?? DEFAULT_GET_TTL_S });
}

// Presigned single-part PUT (browser → R2 direct upload; step 4 of the
// migration plan). The client must send exactly this Content-Type.
export async function presignR2Put(
  key: string,
  opts: { expiresIn?: number; contentType?: string; contentLength?: number } = {},
): Promise<string> {
  if (!isSafeR2Key(key)) throw new Error("invalid R2 key");
  const cmd = new PutObjectCommand({
    Bucket: r2Bucket(),
    Key: key,
    ContentType: opts.contentType,
    ContentLength: opts.contentLength,
  });
  return getSignedUrl(r2Client(), cmd, { expiresIn: opts.expiresIn ?? DEFAULT_GET_TTL_S });
}

// Size in bytes, or null when the object does not exist.
export async function headR2(key: string): Promise<number | null> {
  if (!isSafeR2Key(key)) return null;
  try {
    const res = await r2Client().send(new HeadObjectCommand({ Bucket: r2Bucket(), Key: key }));
    return typeof res.ContentLength === "number" ? res.ContentLength : 0;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
    throw err;
  }
}

// Generated artifacts (migration plan step 3, 2026-09-23): 超解像 / Director /
// Multi-Angle / 特化ワークフロー rows keep their Volume-relative path in a
// plain column (`result_url` / `video_url` / `images[]`); the worker-side
// CPU publish uploads each file to the key == relative path and lists the
// moved paths in `metadata.r2_keys`. A route presigns a path only when it is
// listed there — otherwise the Volume copy still exists and the Modal
// endpoint keeps serving it (no gap while the publish is in flight).
export function r2KeysFromMetadata(meta: unknown): string[] {
  const keys = (meta as { r2_keys?: unknown } | null)?.r2_keys;
  return Array.isArray(keys) ? keys.filter(isSafeR2Key) : [];
}

export function isPublishedToR2(meta: unknown, relPath: string): boolean {
  return r2Enabled() && isSafeR2Key(relPath) && r2KeysFromMetadata(meta).includes(relPath);
}

/** The R2 key a published `relPath` was stored under: `metadata.r2_key_map`
 * (per-user layout, 2026-09-24〜), else the path itself (older rows). */
function publishedKeyOf(meta: unknown, relPath: string): string {
  const map = (meta as { r2_key_map?: unknown } | null)?.r2_key_map;
  const mapped = map && typeof map === "object" ? (map as Record<string, unknown>)[relPath] : undefined;
  return isSafeR2Key(mapped) ? mapped : relPath;
}

/** Presigned GET for `relPath` when the row says it lives in R2, else null
 * (caller falls back to the Modal signed link). Never throws. */
export async function presignPublishedArtifact(
  meta: unknown,
  relPath: string,
  opts: { expiresIn?: number; downloadName?: string; contentType?: string } = {},
): Promise<string | null> {
  if (!isPublishedToR2(meta, relPath)) return null;
  try {
    return await presignR2Get(publishedKeyOf(meta, relPath), opts);
  } catch (err) {
    console.error("[r2] presign failed for", relPath, err);
    return null;
  }
}

// admin bucket browser (migration plan step 6, 2026-09-24): one directory
// level under `prefix` ("" = bucket root → the <kind>/ folders). Folders are
// CommonPrefixes, files are Contents. Paginated; ordering folders first.
export type R2Entry = {
  name: string;
  path: string;
  isFolder: boolean;
  sizeBytes: number | null;
  updatedAt: string | null;
};

export async function listR2Prefix(prefix: string): Promise<R2Entry[]> {
  const clean = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  const base = clean ? `${clean}/` : "";
  const out: R2Entry[] = [];
  let token: string | undefined;
  do {
    const res = await r2Client().send(
      new ListObjectsV2Command({ Bucket: r2Bucket(), Prefix: base, Delimiter: "/", ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const cp of res.CommonPrefixes ?? []) {
      const p = (cp.Prefix ?? "").replace(/\/$/, "");
      if (!p) continue;
      out.push({ name: p.slice(base.length), path: p, isFolder: true, sizeBytes: null, updatedAt: null });
    }
    for (const obj of res.Contents ?? []) {
      const key = obj.Key ?? "";
      if (!key || key === base) continue;
      out.push({
        name: key.slice(base.length),
        path: key,
        isFolder: false,
        sizeBytes: typeof obj.Size === "number" ? obj.Size : null,
        updatedAt: obj.LastModified ? obj.LastModified.toISOString() : null,
      });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  out.sort((a, b) => (a.isFolder !== b.isFolder ? (a.isFolder ? -1 : 1) : a.name.localeCompare(b.name)));
  return out;
}

/** Every key under `prefix` (recursive, capped). */
export async function listR2Keys(prefix: string, cap = 5000): Promise<string[]> {
  const base = prefix.replace(/^\/+/, "").replace(/\/+$/, "") + "/";
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await r2Client().send(
      new ListObjectsV2Command({ Bucket: r2Bucket(), Prefix: base, ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    token = res.IsTruncated && keys.length < cap ? res.NextContinuationToken : undefined;
  } while (token);
  return keys.slice(0, cap);
}

// Best-effort bulk delete (≤1000 keys per call, the S3 limit). Missing keys
// are not an error. Returns the number of keys sent.
export async function deleteR2Keys(keys: string[]): Promise<number> {
  const safe = keys.filter(isSafeR2Key);
  let sent = 0;
  for (let i = 0; i < safe.length; i += 1000) {
    const chunk = safe.slice(i, i + 1000);
    await r2Client().send(
      new DeleteObjectsCommand({
        Bucket: r2Bucket(),
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    sent += chunk.length;
  }
  return sent;
}
