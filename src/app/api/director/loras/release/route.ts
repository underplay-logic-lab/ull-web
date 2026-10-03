import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isDirectorLoraR2Key, verifyDirectorLoraRelease } from "@/lib/directorLoraUpload.server";
import { deleteR2Keys } from "@/lib/r2.server";

// Director の持ち込み LoRA を、タブを閉じたときに消す（2026-10-04）。画面が pagehide で sendBeacon する
// （Authorization を付けられないので、アップロード開始時に渡した署名で本人の画面か確かめる）。
// その LoRA を使うジョブがまだ取り込み前（予約・起動待ち・実行中）なら消さない — 残りは R2 の 1 日のライフサイクルが消す。
export const maxDuration = 15;

export async function POST(request: Request) {
  let body: { key?: unknown; sig?: unknown } = {};
  try {
    body = JSON.parse(await request.text()) as { key?: unknown; sig?: unknown };
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key : "";
  const sig = typeof body.sig === "string" ? body.sig : "";
  if (!isDirectorLoraR2Key(key) || !verifyDirectorLoraRelease(key, sig)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data: pending, error } = await supabaseAdmin
    .from("generation_jobs")
    .select("id")
    .eq("workflow_type", "director")
    .eq("inputs->>lora_upload_r2_key", key)
    .in("status", ["reserved", "queued", "processing"])
    .limit(1);
  if (error) {
    console.error("[director/loras/release] lookup failed:", error.message);
    return NextResponse.json({ kept: true }, { status: 200 });
  }
  if (pending && pending.length > 0) return NextResponse.json({ kept: true });

  await deleteR2Keys([key]).catch((err) => console.error("[director/loras/release] delete failed:", err));
  return NextResponse.json({ deleted: true });
}
