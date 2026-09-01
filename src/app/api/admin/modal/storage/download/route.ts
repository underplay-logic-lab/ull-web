import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { readVolumeFile, signAdminVolumeUrl } from "@/lib/modalStorage";

// Two modes:
//  - default: 302 -> a short-lived signed Modal URL that streams the file
//    straight to the browser (one hop, Content-Disposition: attachment). The
//    old base64-through-this-route path OOM'd / timed out a Vercel function
//    on GB-scale .safetensors. A hidden <iframe src> pointed here follows the
//    redirect and drops the file into the download bar.
//  - ?inline=1: still proxied as bytes (small <video>/<img> previews in
//    LogsTab) — those need a same-origin URL and are tiny.
function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
}

export async function GET(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const url = new URL(request.url);
  const filePath = url.searchParams.get("file_path");
  const inline = url.searchParams.get("inline") === "1";
  if (!filePath) {
    return NextResponse.json({ error: "file_path が指定されていません。" }, { status: 400 });
  }

  // Default: hand the browser a signed direct-download URL (one hop, no
  // Vercel-function byte limit). `?json=1` returns it instead of redirecting
  // (for a hidden-iframe caller that wants to know the URL up front).
  if (!inline) {
    try {
      const signed = signAdminVolumeUrl("file", filePath);
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

  try {
    const { filename, base64 } = await readVolumeFile(filePath);
    const buffer = Buffer.from(base64, "base64");
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": inline ? contentTypeFor(filename) : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(filename)}"`,
        "Content-Length": String(buffer.byteLength),
      },
    });
  } catch (err) {
    console.error("[admin/modal/storage/download] read failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ダウンロードに失敗しました。" },
      { status: 502 },
    );
  }
}
