import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { cancelReserved, isQueueKind, listReserved, userIdFromBearer } from "@/lib/studioQueue.server";

// 自分の予約（順番待ち）の一覧と取り消し（2026-10-03、lib/studioQueue.server.ts）。
// 取り消せるのは始まる前（reserved）のうちだけ・全額返金。
export const maxDuration = 15;

export async function GET(request: Request) {
  const userId = await userIdFromBearer(request);
  if (!userId) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  const kind = new URL(request.url).searchParams.get("kind");
  if (!isQueueKind(kind)) return NextResponse.json({ error: "kind が不正です。" }, { status: 400 });
  const reserved = await listReserved(kind, userId);
  return NextResponse.json({ reserved: reserved.map((r) => r.id) });
}

export async function DELETE(request: Request) {
  const userId = await userIdFromBearer(request);
  if (!userId) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  let body: { kind?: unknown; jobIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です。" }, { status: 400 });
  }
  if (!isQueueKind(body.kind)) return NextResponse.json({ error: "kind が不正です。" }, { status: 400 });
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter((x): x is string => typeof x === "string") : undefined;
  try {
    const res = await cancelReserved(body.kind, userId, jobIds);
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("credits")
      .eq("id", userId)
      .single();
    return NextResponse.json({ ok: true, ...res, remainingCredits: (data?.credits as number | null) ?? null });
  } catch (err) {
    console.error("[studio/queue] cancel failed:", err);
    return NextResponse.json({ error: "予約の取り消しに失敗しました。" }, { status: 500 });
  }
}
