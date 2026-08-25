import { NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { requireAdmin } from "@/lib/adminApiGuard";

// Powers EditableMedia's "public/ から選択" picker. Read-only enumeration
// of public/ with no user-supplied path input at all (so there is nothing
// to traverse/inject) — admin-gated purely because it's under /api/admin.
const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp4", ".webm"]);

type PublicAsset = { path: string; size: number };

async function walk(dir: string, base: string): Promise<PublicAsset[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: PublicAsset[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push(...(await walk(fullPath, relPath)));
    } else if (MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const stats = await stat(fullPath);
      results.push({ path: `/${relPath}`, size: stats.size });
    }
  }

  return results;
}

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  try {
    const publicDir = path.join(process.cwd(), "public");
    const assets = await walk(publicDir, "");
    return NextResponse.json({ assets });
  } catch (err) {
    console.error("[admin/public-assets] listing failed:", err);
    return NextResponse.json({ error: "アセット一覧の取得に失敗しました。" }, { status: 500 });
  }
}
