import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  GENERATED_BUCKETS,
  bucketMeta,
  isGeneratedBucket,
  listPrefix,
  publicUrl,
  removePath,
  signedUrl,
} from "@/lib/generatedStorage";
import { deleteR2Keys, listR2Keys, listR2Prefix, presignR2Get, r2Configured } from "@/lib/r2.server";

// 2026-09-24（R2 移行 計画 6）: 新規の成果物・持ち込みは全部 R2 に居るので、
// 仮想バケット "r2" として同じブラウザに出す。階層は <kind>/<user_id>/<job_id>/…
// （R2 のキー = Volume 相対パス）。表示は署名付き GET（15 分）、削除は prefix 配下
// を一括削除。ファイル操作を作り込まない方針（計画 9、整理作業は rclone マウント）
// なので、一覧・開く・消すだけ。
const R2_BUCKET_ID = "r2";
const R2_BUCKET_INFO = { id: R2_BUCKET_ID, label: "R2（2026-09-23〜 成果物・持ち込み）", public: false } as const;

// admin「生成物 & ストレージ」— Supabase Storage バケットブラウザ。
//   GET  ?bucket=<id>&prefix=<path>  … その階層の直下エントリ
//   DELETE { bucket, path, is_folder } … ファイル / フォルダ削除

function sanitizePrefix(raw: string): string | null {
  const s = (raw ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return "";
  if (s.includes("..") || s.includes("\\")) return null;
  return s;
}

export async function GET(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const url = new URL(request.url);
  const bucket = url.searchParams.get("bucket") ?? "";
  const prefix = sanitizePrefix(url.searchParams.get("prefix") ?? "");

  if (!bucket) {
    return NextResponse.json({ buckets: r2Configured() ? [R2_BUCKET_INFO, ...GENERATED_BUCKETS] : GENERATED_BUCKETS });
  }
  if (prefix === null) {
    return NextResponse.json({ error: "パスが不正です。" }, { status: 400 });
  }
  if (bucket === R2_BUCKET_ID) {
    if (!r2Configured()) return NextResponse.json({ error: "R2 が設定されていません。" }, { status: 400 });
    let r2Entries;
    try {
      r2Entries = await listR2Prefix(prefix);
    } catch (err) {
      console.error("[admin/storage/objects] r2 list failed:", err);
      return NextResponse.json({ error: "R2 の一覧取得に失敗しました。" }, { status: 502 });
    }
    const entries = await Promise.all(
      r2Entries.map(async (e) => ({
        ...e,
        mimeType: null as string | null,
        url: e.isFolder ? null : await presignR2Get(e.path).catch(() => null),
      })),
    );
    // 旧配置（〜2026-09-24）は <kind>/ の直下のフォルダ名が user_id。新配置は最上位が
    // `<email>_<id8>` でそのまま読めるので、UUID の形のフォルダだけ引く。
    let emailByFolder: Record<string, string | null> = {};
    if (prefix && !prefix.includes("/")) {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const ids = entries.filter((e) => e.isFolder && uuidRe.test(e.name)).map((e) => e.name);
      if (ids.length > 0) {
        const { data } = await supabaseAdmin.from("profiles").select("id, email").in("id", ids);
        emailByFolder = Object.fromEntries((data ?? []).map((r) => [r.id as string, (r.email as string) ?? null]));
      }
    }
    return NextResponse.json({
      bucket,
      prefix,
      public: false,
      breadcrumb: prefix ? prefix.split("/") : [],
      entries,
      emailByFolder,
    });
  }
  if (!isGeneratedBucket(bucket)) {
    return NextResponse.json({ error: "不明なバケットです。" }, { status: 400 });
  }

  let entries;
  try {
    entries = await listPrefix(bucket, prefix);
  } catch (err) {
    console.error("[admin/storage/objects] list failed:", err);
    return NextResponse.json({ error: "一覧の取得に失敗しました。" }, { status: 502 });
  }

  const meta = bucketMeta(bucket);
  const isPublic = Boolean(meta?.public);

  // ファイルには表示/DL 用 URL を付ける（public はそのまま、private は署名 URL）。
  const withUrls = await Promise.all(
    entries.map(async (e) => {
      if (e.isFolder) return { ...e, url: null as string | null };
      const u = isPublic ? publicUrl(bucket, e.path) : await signedUrl(bucket, e.path, 900);
      return { ...e, url: u };
    }),
  );

  // ルート階層（prefix === ""）のフォルダ名は user_id。email を解決する。
  let emailByFolder: Record<string, string | null> = {};
  if (prefix === "") {
    const ids = withUrls.filter((e) => e.isFolder).map((e) => e.name);
    if (ids.length > 0) {
      const { data } = await supabaseAdmin
        .from("profiles")
        .select("id, email")
        .in("id", ids);
      emailByFolder = Object.fromEntries((data ?? []).map((r) => [r.id as string, (r.email as string) ?? null]));
    }
  }

  const crumbs = prefix ? prefix.split("/") : [];

  return NextResponse.json({
    bucket,
    prefix,
    public: isPublic,
    breadcrumb: crumbs,
    entries: withUrls,
    emailByFolder,
  });
}

export async function DELETE(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  const bucket = typeof body?.bucket === "string" ? body.bucket : "";
  const path = sanitizePrefix(typeof body?.path === "string" ? body.path : "");
  const isFolder = body?.is_folder === true;

  if (!path) {
    return NextResponse.json({ error: "削除対象のパスが不正です。" }, { status: 400 });
  }
  if (bucket === R2_BUCKET_ID) {
    try {
      const keys = isFolder ? await listR2Keys(path) : [path];
      const removed = await deleteR2Keys(keys);
      return NextResponse.json({ ok: true, removed });
    } catch (err) {
      console.error("[admin/storage/objects] r2 delete failed:", err);
      return NextResponse.json({ error: err instanceof Error ? err.message : "削除に失敗しました。" }, { status: 502 });
    }
  }
  if (!isGeneratedBucket(bucket)) {
    return NextResponse.json({ error: "不明なバケットです。" }, { status: 400 });
  }

  try {
    const removed = await removePath(bucket, path, isFolder);
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    console.error("[admin/storage/objects] delete failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "削除に失敗しました。" },
      { status: 502 },
    );
  }
}
