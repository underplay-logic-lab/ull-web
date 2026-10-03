import { NextResponse } from "next/server";
import { advanceQueue, isQueueKind, listReserved, sweepAllQueues, userIdFromBearer } from "@/lib/studioQueue.server";

// 予約の次の 1 件を起動する（2026-10-03、lib/studioQueue.server.ts）。
// 呼ぶのは: ① DB トリガー（前のジョブが完了・失敗、pg_net・Bearer STUDIO_QUEUE_SECRET と userId。
//              同じ値を Supabase Vault の studio_queue_secret に入れておく）
//           ② 画面（完了を見たとき・開いたとき、Bearer ユーザーのトークン＝自分の分だけ）
// 順番が来ていなければ何もしない（何度呼ばれても害は無い）。
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: { kind?: unknown; userId?: unknown };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const secret = process.env.STUDIO_QUEUE_SECRET;
  const isServer = Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;

  if (isServer && body.kind === undefined && body.userId === undefined) {
    const started = await sweepAllQueues();
    return NextResponse.json({ ok: true, started });
  }
  if (!isQueueKind(body.kind)) return NextResponse.json({ error: "kind が不正です。" }, { status: 400 });
  const kind = body.kind;

  const userId = isServer
    ? typeof body.userId === "string" ? body.userId : null
    : await userIdFromBearer(request);
  if (!userId) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

  const started = await advanceQueue(kind, userId);
  const reserved = await listReserved(kind, userId);
  return NextResponse.json({ ok: true, started, reserved: reserved.map((r) => r.id) });
}
