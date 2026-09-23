import "server-only";
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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

// `<kind>/<user_id>/<job_id>/<file>` — identical to the Volume-relative path
// so metadata.checkpoints[].path and .r2_key read the same.
export function r2ArtifactKey(kind: R2ArtifactKind, userId: string, jobId: string, file: string): string {
  return `${kind}/${userId}/${jobId}/${file}`;
}

// Defensive key check for anything that came out of a DB row: no leading
// slash, no traversal, printable ASCII only.
const SAFE_KEY_RE = /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,511}$/;
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
