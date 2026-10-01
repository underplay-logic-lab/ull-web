import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// admin「実稼働ログ」— GPU 待ちの見張り（2026-10-01、ローンチ後）。
//
// Modal の同時 GPU は 10 台まで。埋まると新しいジョブは Modal 側で GPU が空くまで待たされ、ユーザーには
// 「GPU を起動しています」が長く出続ける。その兆候を created_at → processing_started_at の伸びで拾う。
// 順番待ち（無料）はブラウザ側で予約を持ち、DB の行は実際に投げた時点で作られるので、この差に
// 「自分の前のジョブ待ち」は混ざらない（＝GPU の確保＋起動だけ）。
//
// 超解像のバッチは N 行を 1 台で順に処理するので、待ち時間は先頭の行（batch_index 0）だけで測る。
// 種別ごとにコールドスタートの長さが違う（重いモデルほど起動が遅い）ので、閾値は一律にせず
// 過去 7 日の p90 を基準に「基準の 1.5 倍、かつ 2 分超」で目立たせる。

const BASELINE_DAYS = 7;
const RECENT_HOURS = 24;
// これより古い pending/queued は取り残し（ディスパッチ失敗等）として待ち一覧から外す。
const STALE_WAITING_HOURS = 6;
const MIN_ALERT_SECONDS = 120;
const ALERT_FACTOR = 1.5;
const MODAL_GPU_LIMIT = 10;

type Row = {
  id: string;
  status: string;
  created_at: string;
  processing_started_at: string | null;
  kind: string;
  waitingStatus: boolean;
  // 同じコンテナで順に処理するまとまり（超解像バッチ）。実行中の台数はこの単位で数える。
  unit: string;
  // まとまりの 2 件目以降は「前の件の処理待ち」で GPU 待ちではないので、待ち時間の集計から外す。
  followsInUnit: boolean;
};

const TABLES = [
  {
    table: "generation_jobs",
    select: "id, status, created_at, processing_started_at, workflow_type",
    waiting: ["queued"],
    kind: (r: Record<string, unknown>) => {
      const w = String(r.workflow_type ?? "");
      return w === "lora_training" ? "LoRA 学習" : w === "director" ? "動画（Director）" : `動画（${w || "不明"}）`;
    },
  },
  {
    table: "angle_jobs",
    select: "id, status, created_at, processing_started_at, mode, metadata->kind",
    waiting: ["pending"],
    kind: (r: Record<string, unknown>) => (r.kind === "scene" ? "場面（Qwen）" : "角度（Qwen）"),
  },
  {
    table: "upscale_jobs",
    select: "id, status, created_at, processing_started_at, model_key, batch_id, batch_index",
    waiting: ["pending"],
    kind: () => "超解像",
  },
] as const;

const percentile = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const waitSeconds = (r: Row) =>
  r.processing_started_at ? (Date.parse(r.processing_started_at) - Date.parse(r.created_at)) / 1000 : null;

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const now = Date.now();
  const since = new Date(now - BASELINE_DAYS * 86400_000).toISOString();

  const results = await Promise.all(
    TABLES.map(async (t) => {
      const { data, error } = await supabaseAdmin
        .from(t.table)
        .select(t.select)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw new Error(`${t.table}: ${error.message}`);
      return ((data ?? []) as unknown as Record<string, unknown>[]).map(
        (r): Row => ({
          id: String(r.id),
          status: String(r.status ?? ""),
          created_at: String(r.created_at),
          processing_started_at: (r.processing_started_at as string | null) ?? null,
          kind: t.kind(r),
          waitingStatus: (t.waiting as readonly string[]).includes(String(r.status ?? "")),
          unit: String(r.batch_id ?? r.id),
          followsInUnit: Number(r.batch_index ?? 0) > 0,
        }),
      );
    }),
  ).catch((e: Error) => e);
  if (results instanceof Error) {
    return NextResponse.json({ error: results.message }, { status: 500 });
  }
  const allRows = results.flat();
  const rows = allRows.filter((r) => !r.followsInUnit);

  // 種別ごとの基準（過去 7 日、起動まで行ったジョブ）
  const byKind = new Map<string, number[]>();
  for (const r of rows) {
    const w = waitSeconds(r);
    if (w == null || w < 0) continue;
    const list = byKind.get(r.kind) ?? [];
    list.push(w);
    byKind.set(r.kind, list);
  }
  const alertAt = (kind: string) => {
    const p90 = percentile(byKind.get(kind) ?? [], 0.9);
    return Math.max(MIN_ALERT_SECONDS, (p90 ?? 0) * ALERT_FACTOR);
  };

  const recentSince = now - RECENT_HOURS * 3600_000;
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const stats = kinds.map((kind) => {
    const all = byKind.get(kind) ?? [];
    const recent = rows
      .filter((r) => r.kind === kind && Date.parse(r.created_at) >= recentSince)
      .map(waitSeconds)
      .filter((w): w is number => w != null && w >= 0);
    return {
      kind,
      baselineCount: all.length,
      baselineP50: percentile(all, 0.5),
      baselineP90: percentile(all, 0.9),
      recentCount: recent.length,
      recentP50: percentile(recent, 0.5),
      recentMax: recent.length ? Math.max(...recent) : null,
      alertAtSeconds: alertAt(kind),
    };
  });

  // いま GPU を待っているジョブ
  const staleBefore = now - STALE_WAITING_HOURS * 3600_000;
  const waiting = rows
    .filter((r) => r.waitingStatus && !r.processing_started_at && Date.parse(r.created_at) >= staleBefore)
    .map((r) => {
      const ageSeconds = (now - Date.parse(r.created_at)) / 1000;
      return { id: r.id, kind: r.kind, createdAt: r.created_at, ageSeconds, alert: ageSeconds > alertAt(r.kind) };
    })
    .sort((a, b) => b.ageSeconds - a.ageSeconds);

  // 実行中（≒ 使用中の GPU 台数の目安。取り残しの processing を数えないよう 6 時間で切る）
  const running = new Set(
    allRows.filter((r) => r.status === "processing" && Date.parse(r.created_at) >= staleBefore).map((r) => r.unit),
  ).size;

  // 直近 24 時間で待ちが長かったジョブ（過去の詰まりに後から気付けるように）
  const slowRecent = rows
    .filter((r) => Date.parse(r.created_at) >= recentSince)
    .map((r): { r: Row; w: number | null } => ({ r, w: waitSeconds(r) }))
    .filter((x): x is { r: Row; w: number } => x.w != null && x.w > alertAt(x.r.kind))
    .sort((a, b) => b.w - a.w)
    .slice(0, 10)
    .map(({ r, w }) => ({ id: r.id, kind: r.kind, createdAt: r.created_at, waitSeconds: w }));

  return NextResponse.json({
    generatedAt: new Date(now).toISOString(),
    gpuLimit: MODAL_GPU_LIMIT,
    running,
    waiting,
    stats,
    slowRecent,
  });
}
