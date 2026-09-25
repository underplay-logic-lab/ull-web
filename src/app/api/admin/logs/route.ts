import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { makeRowCostJpy } from "@/lib/adminLogsSummary.server";
import { normalizeGpuTier } from "@/lib/pricing/gpuRates";

// admin「実稼働ログ & 粗利監視」（2026-09-25 に作り直し、ホスト指摘「50 件しか見えず、何日分かも分からず、
// CSV にも出せない＝実質使えない」）。
//
//   GET ?from=ISO&to=ISO&type=&status=success|failed&email=&page=1           -> 一覧（まとめて処理は 1 行）＋集計
//   GET ?...&format=csv                                                       -> 絞り込んだ全行の CSV
//
// 集計は絞り込んだ範囲の全行で出す（日次サマリーと同じ原価計算 makeRowCostJpy）。ローンチ前は件数が少ないので
// 範囲内を全部読んでから束ね・並べ・ページに切る。MAX_ROWS を超えたら truncated を返す。
export const maxDuration = 60;

const PAGE_SIZE = 50;
const MAX_ROWS = 50_000;
const FETCH_CHUNK = 1000;
const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

type LogRow = {
  id: string;
  user_id: string;
  job_id: string | null;
  job_type: string;
  prompt_input: string | null;
  output_file_name: string | null;
  execution_time_ms: number | null;
  credits_consumed: number | null;
  gpu_tier: string | null;
  status: "success" | "failed";
  error_message: string | null;
  created_at: string;
};

const COLUMNS =
  "id, user_id, job_id, job_type, prompt_input, output_file_name, execution_time_ms, credits_consumed, gpu_tier, status, error_message, created_at";

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function jstString(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export async function GET(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const url = new URL(request.url);
  const q = url.searchParams;
  const now = Date.now();
  const toIso = q.get("to") && !Number.isNaN(Date.parse(q.get("to")!)) ? new Date(q.get("to")!).toISOString() : new Date(now).toISOString();
  const fromIso =
    q.get("from") && !Number.isNaN(Date.parse(q.get("from")!))
      ? new Date(q.get("from")!).toISOString()
      : new Date(now - 7 * 24 * 3600_000).toISOString();
  const type = (q.get("type") ?? "").trim();
  const status = q.get("status") === "success" || q.get("status") === "failed" ? q.get("status")! : "";
  const email = (q.get("email") ?? "").trim();
  const page = Math.max(1, Number.parseInt(q.get("page") ?? "1", 10) || 1);
  const asCsv = q.get("format") === "csv";

  // ユーザーはメールの部分一致で絞る（generation_logs には email が無い）。
  let userIds: string[] | null = null;
  if (email) {
    const { data } = await supabaseAdmin.from("profiles").select("id").ilike("email", `%${email}%`).limit(200);
    userIds = (data ?? []).map((r) => r.id as string);
  }

  const rows: LogRow[] = [];
  let truncated = false;
  if (userIds === null || userIds.length > 0) {
    for (let offset = 0; ; offset += FETCH_CHUNK) {
      let query = supabaseAdmin
        .from("generation_logs")
        .select(COLUMNS)
        .gte("created_at", fromIso)
        .lt("created_at", toIso)
        .order("created_at", { ascending: false })
        .range(offset, offset + FETCH_CHUNK - 1);
      if (type) query = query.eq("job_type", type);
      if (status) query = query.eq("status", status);
      if (userIds) query = query.in("user_id", userIds);
      const { data, error } = await query;
      if (error) {
        console.error("[admin/logs] fetch failed:", error.message);
        return NextResponse.json({ error: "ログの取得に失敗しました。" }, { status: 500 });
      }
      rows.push(...((data ?? []) as LogRow[]));
      if (!data || data.length < FETCH_CHUNK) break;
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
    }
  }

  const { rowCostJpy, knobs } = await makeRowCostJpy();
  const marginOf = (credits: number, cost: number) => {
    const revenue = credits * knobs.credit_to_jpy;
    return revenue > 0 ? ((revenue - cost) / revenue) * 100 : null;
  };

  // 超解像の「まとめて処理」は batch_id で 1 行に束ねる（job_id から upscale_jobs を引く）。
  const batchByJob = new Map<string, string>();
  const upscaleJobIds = [...new Set(rows.filter((r) => r.job_type.startsWith("upscale") && r.job_id).map((r) => r.job_id!))];
  for (let i = 0; i < upscaleJobIds.length; i += 200) {
    const { data } = await supabaseAdmin
      .from("upscale_jobs")
      .select("id, batch_id")
      .in("id", upscaleJobIds.slice(i, i + 200));
    for (const r of data ?? []) if (r.batch_id) batchByJob.set(r.id as string, r.batch_id as string);
  }

  // メールアドレス（CSV は全行、一覧は表示するページ分だけ引けば足りるが、件数が少ないので全員分引く）。
  const emailByUser = new Map<string, string>();
  const allUserIds = [...new Set(rows.map((r) => r.user_id))];
  for (let i = 0; i < allUserIds.length; i += 200) {
    const { data } = await supabaseAdmin.from("profiles").select("id, email").in("id", allUserIds.slice(i, i + 200));
    for (const r of data ?? []) emailByUser.set(r.id as string, r.email as string);
  }

  if (asCsv) {
    const header = [
      "日時(JST)",
      "機能",
      "状態",
      "ユーザー",
      "GPU",
      "処理秒",
      "消費クレジット",
      "推定原価(円)",
      "推定売上(円)",
      "粗利率(%)",
      "エラー",
      "ジョブID",
      "バッチID",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      const cost = rowCostJpy(r);
      const credits = r.credits_consumed ?? 0;
      const margin = marginOf(credits, cost);
      lines.push(
        [
          jstString(r.created_at),
          r.job_type,
          r.status === "success" ? "成功" : "失敗",
          emailByUser.get(r.user_id) ?? r.user_id,
          normalizeGpuTier(r.gpu_tier)?.label ?? r.gpu_tier ?? "",
          ((r.execution_time_ms ?? 0) / 1000).toFixed(1),
          credits,
          cost.toFixed(1),
          (credits * knobs.credit_to_jpy).toFixed(1),
          margin === null ? "" : margin.toFixed(1),
          r.error_message ?? "",
          r.job_id ?? "",
          (r.job_id && batchByJob.get(r.job_id)) ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    // Excel で文字化けしないよう BOM を付ける。
    const body = "﻿" + lines.join("\r\n");
    const name = `generation_logs_${jstString(fromIso).slice(0, 10)}_${jstString(toIso).slice(0, 10)}.csv`;
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  }

  // --- 集計（絞り込んだ範囲の全行）---
  let successCount = 0;
  let failedCount = 0;
  let credits = 0;
  let cost = 0;
  let failedCost = 0;
  let lowMarginCount = 0;
  let negativeMarginCount = 0;
  const byType = new Map<string, { count: number; credits: number; cost: number }>();
  for (const r of rows) {
    const c = rowCostJpy(r);
    const cr = r.credits_consumed ?? 0;
    cost += c;
    credits += cr;
    if (r.status === "success") {
      successCount += 1;
      const m = marginOf(cr, c);
      if (m !== null) {
        if (m < 0) negativeMarginCount += 1;
        if (m < knobs.alert_low_margin_percent) lowMarginCount += 1;
      }
    } else {
      failedCount += 1;
      failedCost += c;
    }
    const t = byType.get(r.job_type) ?? { count: 0, credits: 0, cost: 0 };
    t.count += 1;
    t.credits += cr;
    t.cost += c;
    byType.set(r.job_type, t);
  }
  const revenue = credits * knobs.credit_to_jpy;

  // --- 一覧（まとめて処理は 1 行に束ねる）---
  type Item = ReturnType<typeof toItem>;
  const toItem = (r: LogRow) => {
    const c = rowCostJpy(r);
    return {
      ...r,
      user_email: emailByUser.get(r.user_id) ?? null,
      gpu_tier_label: normalizeGpuTier(r.gpu_tier)?.label ?? (r.gpu_tier === "none" ? "未起動" : null),
      cost_jpy: c,
      margin_percent: marginOf(r.credits_consumed ?? 0, c),
    };
  };
  const groups = new Map<string, Item[]>();
  for (const r of rows) {
    const batch = r.job_id ? batchByJob.get(r.job_id) : undefined;
    const key = batch ? `batch:${batch}` : `row:${r.id}`;
    const list = groups.get(key) ?? [];
    list.push(toItem(r));
    groups.set(key, list);
  }
  const entries = [...groups.entries()].map(([key, items]) => {
    if (items.length === 1 && key.startsWith("row:")) return { kind: "row" as const, key, log: items[0] };
    const sum = (f: (i: Item) => number) => items.reduce((t, i) => t + f(i), 0);
    const c = sum((i) => i.cost_jpy);
    const cr = sum((i) => i.credits_consumed ?? 0);
    return {
      kind: "batch" as const,
      key,
      batch: {
        batch_id: key.slice("batch:".length),
        job_type: items[0].job_type,
        user_email: items[0].user_email,
        user_id: items[0].user_id,
        created_at: items[0].created_at, // rows は新しい順なので先頭が最新
        count: items.length,
        success: items.filter((i) => i.status === "success").length,
        failed: items.filter((i) => i.status !== "success").length,
        execution_time_ms: sum((i) => i.execution_time_ms ?? 0),
        credits_consumed: cr,
        cost_jpy: c,
        margin_percent: marginOf(cr, c),
        gpu_tier_label: [...new Set(items.map((i) => i.gpu_tier_label).filter(Boolean))].join(" / ") || null,
        items,
      },
    };
  });
  entries.sort((a, b) => {
    const ta = a.kind === "row" ? a.log.created_at : a.batch.created_at;
    const tb = b.kind === "row" ? b.log.created_at : b.batch.created_at;
    return tb.localeCompare(ta);
  });
  const totalEntries = entries.length;
  const pageEntries = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // 直近 24 時間の低粗利アラート（絞り込みとは独立。画面上部の警告用）。
  const alertSinceIso = new Date(now - ALERT_WINDOW_MS).toISOString();
  const { data: alertRows } = await supabaseAdmin
    .from("generation_logs")
    .select("job_type, execution_time_ms, credits_consumed, gpu_tier, status")
    .gte("created_at", alertSinceIso)
    .eq("status", "success");
  let alertLow = 0;
  let alertNeg = 0;
  for (const r of alertRows ?? []) {
    const m = marginOf(r.credits_consumed ?? 0, rowCostJpy(r));
    if (m === null) continue;
    if (m < 0) alertNeg += 1;
    if (m < knobs.alert_low_margin_percent) alertLow += 1;
  }

  return NextResponse.json({
    range: { from: fromIso, to: toIso },
    page,
    pageSize: PAGE_SIZE,
    totalEntries,
    totalRows: rows.length,
    truncated,
    entries: pageEntries,
    summary: {
      totalCount: rows.length,
      successCount,
      failedCount,
      totalCreditsConsumed: credits,
      totalCostJpy: cost,
      failedCostJpy: failedCost,
      totalRevenueJpy: revenue,
      marginPercent: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null,
      lowMarginCount,
      negativeMarginCount,
      byJobType: [...byType.entries()]
        .map(([jobType, v]) => ({ jobType, ...v }))
        .sort((a, b) => b.cost - a.cost),
    },
    alert: {
      windowHours: ALERT_WINDOW_MS / 3600_000,
      thresholdPercent: knobs.alert_low_margin_percent,
      lowMarginCount: alertLow,
      negativeMarginCount: alertNeg,
    },
  });
}
