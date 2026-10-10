import { supabase } from "@/lib/supabaseClient";

// 予約（順番待ち）をサーバー側で流す仕組みの画面側（2026-10-03、lib/studioQueue.server.ts）。
// 予約は DB（status 'reserved'）にあるので、リロード・タブを閉じても消えない。
export type StudioQueueKind = "angle" | "upscale_image" | "upscale_video" | "director" | "song" | "face_swap" | "worldgen";

async function authHeader(): Promise<Record<string, string> | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

/** 順番が来ていれば次を起動させる。起動したジョブ id と、残っている予約（古い順）を返す。 */
export async function advanceStudioQueue(
  kind: StudioQueueKind,
): Promise<{ started: string | null; reserved: string[] } | null> {
  const auth = await authHeader();
  if (!auth) return null;
  const res = await fetch("/api/studio/queue/advance", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { started?: unknown; reserved?: unknown } | null;
  return {
    started: typeof body?.started === "string" ? body.started : null,
    reserved: Array.isArray(body?.reserved) ? body.reserved.filter((x): x is string => typeof x === "string") : [],
  };
}

/** 予約を取り消す（jobIds を省くと同じ種類の予約を全部）。始まる前のものだけ・全額返金。 */
export async function cancelStudioQueue(
  kind: StudioQueueKind,
  jobIds?: string[],
): Promise<{ cancelled: string[]; refunded: number; remainingCredits: number | null }> {
  const auth = await authHeader();
  if (!auth) throw new Error("ログインが必要です。");
  const res = await fetch("/api/studio/queue", {
    method: "DELETE",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ...(jobIds ? { jobIds } : {}) }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : "予約の取り消しに失敗しました。");
  return {
    cancelled: Array.isArray(body?.cancelled) ? body.cancelled.filter((x): x is string => typeof x === "string") : [],
    refunded: Number(body?.refunded ?? 0),
    remainingCredits: typeof body?.remainingCredits === "number" ? body.remainingCredits : null,
  };
}
