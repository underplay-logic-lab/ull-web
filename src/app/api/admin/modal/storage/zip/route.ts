import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { signAdminVolumeUrl } from "@/lib/modalStorage";

// 302 -> a short-lived signed Modal URL. The Modal endpoint
// (admin_zip_volume_folder in modal_lora_worker.py) runs on a CPU container
// (0 GPU cost), ZIP_STORED-bundles the whole folder, and streams it back
// with Content-Disposition: attachment. A hidden <iframe src> pointed here
// follows the redirect and the ZIP lands in the download bar.
export const maxDuration = 30;

export async function GET(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "path が指定されていません。" }, { status: 400 });
  }

  try {
    const signed = signAdminVolumeUrl("zip", path);
    if (url.searchParams.get("json") === "1") {
      return NextResponse.json({ downloadUrl: signed });
    }
    return NextResponse.redirect(signed, 302);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "URLの生成に失敗しました。" },
      { status: 500 },
    );
  }
}
