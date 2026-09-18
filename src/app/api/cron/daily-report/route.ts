import { NextResponse } from "next/server";
import { summarizeGenerationLogs, type GenerationLogsPeriodSummary } from "@/lib/adminLogsSummary.server";
import { sendDiscordEmbed } from "@/lib/discordNotify.server";

// 実稼働ログの日次サマリー（毎日JST 0時）+ 月次サマリー（毎月1日のみ追加で
// 送信）を Discord へ投稿する（2026-09-18導入、ホスト要望）。vercel.json の
// crons が "0 15 * * *"（UTC 15:00 = JST 0:00）でこのルートを叩く——月次は
// 別スケジュールを組まず、日次と同じトリガーで「今日がJSTで1日か」を
// 判定して合わせて送る（cronのタイムゾーン/月末日計算の複雑さを避けるため）。
//
// 必要な env（Vercel）: CRON_SECRET（Vercel Cron が自動で
// `Authorization: Bearer $CRON_SECRET` を付けて叩く）、DISCORD_WEBHOOK_URL。
export const maxDuration = 30;

function formatJpy(v: number): string {
  return `¥${Math.round(v).toLocaleString()}`;
}
function formatMargin(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(1)}%`;
}

function summaryFields(s: GenerationLogsPeriodSummary) {
  const topTypes =
    s.byJobType
      .slice(0, 6)
      .map((t) => `${t.jobType}: ${t.count}件 / ${formatJpy(t.costJpy)}`)
      .join("\n") || "-";
  return [
    { name: "総生成数", value: `${s.totalCount}件（成功${s.successCount} / 失敗${s.failedCount}）`, inline: true },
    { name: "消費クレジット", value: `${s.totalCreditsConsumed.toLocaleString()}C`, inline: true },
    { name: "推定原価", value: formatJpy(s.totalCostJpy), inline: true },
    { name: "推定売上", value: formatJpy(s.totalRevenueJpy), inline: true },
    { name: "粗利率", value: formatMargin(s.marginPercent), inline: true },
    { name: "低粗利 / 原価割れ", value: `${s.lowMarginCount}件 / ${s.negativeMarginCount}件`, inline: true },
    { name: "機能別内訳（原価順）", value: topTypes },
  ];
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jstNow = new Date(Date.now() + JST_OFFSET_MS);
  const jstYear = jstNow.getUTCFullYear();
  const jstMonth = jstNow.getUTCMonth();
  const jstDate = jstNow.getUTCDate();

  // 前日ぶん（JST日境界）を集計・送信。
  const dayFromIso = new Date(Date.UTC(jstYear, jstMonth, jstDate - 1, 0, 0, 0) - JST_OFFSET_MS).toISOString();
  const dayToIso = new Date(Date.UTC(jstYear, jstMonth, jstDate, 0, 0, 0) - JST_OFFSET_MS).toISOString();
  const dayLabel = new Date(Date.UTC(jstYear, jstMonth, jstDate - 1)).toISOString().slice(0, 10);

  const daySummary = await summarizeGenerationLogs(dayFromIso, dayToIso);
  await sendDiscordEmbed({
    title: `📊 実稼働ログ日次サマリー（${dayLabel}）`,
    fields: summaryFields(daySummary),
    color: daySummary.negativeMarginCount > 0 ? 0xef4444 : daySummary.lowMarginCount > 0 ? 0xf59e0b : 0x22c55e,
  });

  // JSTで1日なら、先月ぶんの月次サマリーも追加で送信。
  let monthlySent = false;
  if (jstDate === 1) {
    const monthFromIso = new Date(Date.UTC(jstYear, jstMonth - 1, 1, 0, 0, 0) - JST_OFFSET_MS).toISOString();
    const monthToIso = new Date(Date.UTC(jstYear, jstMonth, 1, 0, 0, 0) - JST_OFFSET_MS).toISOString();
    const monthLabel = new Date(Date.UTC(jstYear, jstMonth - 1, 1)).toISOString().slice(0, 7);

    const monthSummary = await summarizeGenerationLogs(monthFromIso, monthToIso);
    await sendDiscordEmbed({
      title: `🗓️ 実稼働ログ月次サマリー（${monthLabel}）`,
      fields: summaryFields(monthSummary),
      color: monthSummary.negativeMarginCount > 0 ? 0xef4444 : monthSummary.lowMarginCount > 0 ? 0xf59e0b : 0x22c55e,
    });
    monthlySent = true;
  }

  return NextResponse.json({ ok: true, day: dayLabel, monthlySent });
}
