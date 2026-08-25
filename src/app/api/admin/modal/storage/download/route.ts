import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { readVolumeFile } from "@/lib/modalStorage";

// Streams a file back out of the Modal Volume — either as a real download
// (e.g. an admin-saved generation under outputs/admin/, or a model file —
// see save_to_volume in scripts/modal_wan_animate.py) via a plain <a href>
// in ModalStorageTab, or (?inline=1) embedded directly as a <video>/<img>
// src for the Admin logs preview feature (see LogsTab.tsx).
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
