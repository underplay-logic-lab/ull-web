import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import {
  ADMIN_UPLOAD_DIRS,
  ADMIN_UPLOAD_NAME_RE,
  signAdminVolumeUploadUrls,
} from "@/lib/modalStorage";

// ローカルPC -> Modal Volume の直アップロード用に、短命の署名付き URL を発行する
// （2026-09-21）。ファイルの実体はここを通らない — ブラウザが Modal の
// エンドポイントへ直接 PUT する（CLAUDE.md §1 の「大容量バイナリは Supabase /
// API route を経由させない」標準。Vercel のリクエストボディ上限 4.5MB は
// 変更できないので、7GB 級のチェックポイントはこの経路しかない）。
//
// 署名の TTL は15分。それより長くかかるアップロードは、クライアントが
// 失効時にここを叩き直して offset から再開する。
export const maxDuration = 30;

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  const subdir = typeof body?.subdir === "string" ? body.subdir.trim() : "";
  const filename = typeof body?.filename === "string" ? body.filename.trim() : "";

  if (!(ADMIN_UPLOAD_DIRS as readonly string[]).includes(subdir)) {
    return NextResponse.json(
      { error: `保存先が不正です。${ADMIN_UPLOAD_DIRS.join(" / ")} のいずれかを指定してください。` },
      { status: 400 },
    );
  }
  if (!ADMIN_UPLOAD_NAME_RE.test(filename)) {
    return NextResponse.json(
      {
        error:
          "ファイル名が不正です。英数字と . _ - のみ、拡張子は .safetensors / .ckpt / .pt / .pth / .bin / .gguf に限ります。",
      },
      { status: 400 },
    );
  }

  try {
    const urls = signAdminVolumeUploadUrls(`${subdir}/${filename}`);
    return NextResponse.json({ ...urls, path: `${subdir}/${filename}` });
  } catch (err) {
    console.error("[admin/modal/storage/upload-url] failed:", err);
    return NextResponse.json({ error: "アップロードURLの発行に失敗しました。" }, { status: 500 });
  }
}
