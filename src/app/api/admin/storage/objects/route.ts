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
    return NextResponse.json({ buckets: GENERATED_BUCKETS });
  }
  if (!isGeneratedBucket(bucket)) {
    return NextResponse.json({ error: "不明なバケットです。" }, { status: 400 });
  }
  if (prefix === null) {
    return NextResponse.json({ error: "パスが不正です。" }, { status: 400 });
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

  if (!isGeneratedBucket(bucket)) {
    return NextResponse.json({ error: "不明なバケットです。" }, { status: 400 });
  }
  if (!path) {
    return NextResponse.json({ error: "削除対象のパスが不正です。" }, { status: 400 });
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
