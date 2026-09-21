import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { getVolumeThumbnail } from "@/lib/modalStorage";

// 画像・動画の小さな JPEG サムネイル（2026-09-21）。
//
// これまで admin エクスプローラーのプレビューは
// /api/admin/modal/storage/download?inline=1 で本体をそのまま中継していたため、
// 動画を開いた瞬間に数十MBを転送していて遅かった（ホスト指摘）。こちらは
// Modal 側の ffmpeg が1フレームだけ抜いた数十KBの JPEG を返し、Volume に
// キャッシュされるので2回目以降は生成もしない。
//
// 本体（音声付きの再生）は従来の署名付き直リンク経路のまま。サムネイルを
// <video poster> に当てて preload="none" にすることで、「再生を押すまで
// 本体を取りに行かない」挙動になる。
export const maxDuration = 90;

export async function GET(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const filePath = new URL(request.url).searchParams.get("file_path");
  if (!filePath) {
    return NextResponse.json({ error: "file_path が指定されていません。" }, { status: 400 });
  }

  try {
    const jpeg = await getVolumeThumbnail(filePath);
    return new NextResponse(new Uint8Array(jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        // Volume 側でも mtime 込みのキーでキャッシュしているので、ブラウザにも
        // 長めに持たせて良い（差し替わればキーが変わる = URL は同じだが
        // Modal 側が作り直す）。private: admin 専用レスポンス。
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("[admin/modal/storage/thumb] failed:", err);
    return NextResponse.json({ error: "サムネイルの生成に失敗しました。" }, { status: 502 });
  }
}
