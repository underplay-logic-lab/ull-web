import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { getVolumeDirStats } from "@/lib/modalStorage";

// フォルダ行の「ファイル数 / 容量」表示用（2026-09-21）。ファイル一覧を
// 描画した後に、その階層の子ディレクトリぶんをまとめて1回で集計する。
// Volume 全体を走査する ?usage=1 とは別物（あちらは admin が明示的に
// 「実使用量を計算」を押した時だけ）。
export const maxDuration = 120;

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  const paths = Array.isArray(body?.paths)
    ? (body.paths as unknown[]).filter((p): p is string => typeof p === "string").slice(0, 200)
    : [];
  if (paths.length === 0) return NextResponse.json({ stats: {} });

  try {
    const stats = await getVolumeDirStats(paths);
    return NextResponse.json({ stats });
  } catch (err) {
    console.error("[admin/modal/storage/stats] failed:", err);
    return NextResponse.json({ error: "フォルダの集計に失敗しました。" }, { status: 502 });
  }
}
