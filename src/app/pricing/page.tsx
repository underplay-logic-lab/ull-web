import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import type { PricingKnobs } from "@/lib/pricing/knobDefaults";
import { angleCreditsPerAngle } from "@/lib/angleStudio";
import { upscaleCredits, upscaleVideoCostBreakdown } from "@/lib/upscaleStudio";
import { directorCostBreakdownForDuration, directorQwenScriptSurcharge } from "@/lib/directorPricing";
import { guiLoraPricingConfig, loraPriceBreakdown } from "@/lib/loraPricing";
import { autoLoraRankAlpha, autoLoraSteps } from "@/lib/loraCredits";
import { recommendedResolution, loraPresetById, type LoraBaseArchitecture } from "@/lib/loraModels";

// 機能ごとの消費クレジット（2026-09-26、docs/pricing-decision-sheet.md §3）。数字はすべて公開 knob から
// 各タブ・API と同じ関数で計算するので、admin で単価を変えても表が古くならない（約 1 分で反映）。
// 基盤モデル名・GPU 型番は出さない（CLAUDE.md §2。LoRA のモデル名だけは例外で実名）。

export const revalidate = 60;

export const metadata: Metadata = {
  title: "料金の目安 — ULL Studio",
  description: "ULL Studio の各機能で消費するクレジットの目安です。GPU を使った分だけの従量課金です。",
};

// 都度チャージ（¥1,000 / 300C）で換算した 1C あたりの円。月額プランならこれより安い。
const TOPUP_YEN = 1000;
const TOPUP_CREDITS = 300;

type Row = { label: string; note?: string; credits: number };

function yen(credits: number): string {
  return `約 ¥${Math.round((credits * TOPUP_YEN) / TOPUP_CREDITS).toLocaleString("ja-JP")}`;
}

function loraRow(presetId: string, arch: LoraBaseArchitecture, images: number, knobs: PricingKnobs): Row {
  const steps = autoLoraSteps(images, arch);
  const b = loraPriceBreakdown(
    guiLoraPricingConfig({
      arch,
      resolution: recommendedResolution(arch),
      linearRank: autoLoraRankAlpha("character").rank,
      steps,
    }),
    { imageCount: images, knobs, spiOverride: loraPresetById(presetId)?.spiOverride },
  );
  const minutes = Math.max(1, Math.round(b.totalSeconds / 60));
  return {
    label: `${loraPresetById(presetId)?.label ?? presetId}・人物 ${images} 枚`,
    note: `学習 ${steps.toLocaleString("ja-JP")} step・目安 ${minutes} 分`,
    credits: b.credits,
  };
}

function buildSections(knobs: PricingKnobs) {
  const perAngle = angleCreditsPerAngle(knobs);
  const videoUp = (presetId: string) =>
    upscaleVideoCostBreakdown({ durationSec: 10, fps: 30, inW: 1280, inH: 720, presetId, modelKey: "seedvr2_7b", knobs })
      .credits;
  const director = (sec: number, mode: "fast" | "quality") =>
    directorCostBreakdownForDuration({ totalDurationS: sec, mode, knobs }).credits;
  const caption = (n: number) => Math.round(knobs.lora_caption_base + knobs.lora_caption_per_image * n);

  return [
    {
      title: "🎥 Cinematic Director（動画生成）",
      lead: "尺（秒）に比例します。高速は無音、高品質は音声・セリフのリップシンク付きです。",
      rows: [
        { label: "高速・15 秒", credits: director(15, "fast") },
        { label: "高品質（音声あり）・15 秒", credits: director(15, "quality") },
        { label: "高品質（音声あり）・60 秒（最大）", credits: director(60, "quality") },
        { label: "AI に台本を書かせる（任意の追加）", credits: directorQwenScriptSurcharge(knobs) },
      ] as Row[],
    },
    {
      title: "🎭 マルチアングル",
      lead: `1 構図あたり ${perAngle}C。別の角度の参考画像（サブ参照）を足すと、1 枚ごとに 1 構図の単価が上がります。`,
      rows: [
        { label: "3 構図", credits: perAngle * 3 },
        { label: "6 構図（正面・斜め・真横・背面・アオリ・フカン）", credits: perAngle * 6 },
        { label: "6 構図・サブ参照画像 1 枚", credits: angleCreditsPerAngle(knobs, 1) * 6 },
      ] as Row[],
    },
    {
      title: "✨ 4K/8K 超解像（画像）",
      lead: "出力の画素数に比例します。複数枚をまとめて処理でき、料金は 1 枚ずつの合計です。",
      rows: [
        {
          label: "1024×1536 → ×2（2048×3072）",
          credits: upscaleCredits({ inW: 1024, inH: 1536, modeId: "x2", modelKey: "seedvr2_7b", knobs }),
        },
        {
          label: "1024×1536 → ×4（4096×6144）",
          credits: upscaleCredits({ inW: 1024, inH: 1536, modeId: "x4", modelKey: "seedvr2_7b", knobs }),
        },
      ] as Row[],
    },
    {
      title: "🎬 4K 動画超解像",
      lead: "出力の解像度と長さで決まります。例は 720p・30fps・10 秒の動画です。",
      rows: [
        { label: "HD（短辺 1280）", credits: videoUp("hd") },
        { label: "2K（短辺 1920）", credits: videoUp("2k") },
        { label: "4K（短辺 2160）", credits: videoUp("4k") },
      ] as Row[],
    },
    {
      title: "🎨 LoRA Studio",
      lead:
        "学習にかかる GPU 時間の見積もりで決まり、画像の枚数・学習回数で変わります。学習前の画面に正確な金額が出ます。" +
        "AI にキャプションを作らせる場合は、学習とは別にキャプション代がかかります（自分で書けば無料）。",
      rows: [
        loraRow("minimax_h3", "minimax_h3", 30, knobs),
        loraRow("minimax_h3", "minimax_h3", 80, knobs),
        loraRow("wai_illustrious", "sdxl", 30, knobs),
        { label: "AI キャプション作成・30 枚", credits: caption(30) },
      ] as Row[],
    },
  ];
}

export default async function PricingPage() {
  const knobs = await getPricingKnobs();
  const sections = buildSections(knobs);

  return (
    <div className="relative py-32">
      <div className="mx-auto max-w-3xl px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-neon-pink"
        >
          <ArrowLeft size={16} />
          Back to Home
        </Link>

        <h1 className="mt-8 text-3xl font-bold tracking-tight sm:text-4xl">料金の目安</h1>
        <p className="mt-4 text-sm leading-relaxed text-foreground/80">
          ULL Studio は、生成や学習に使った分だけクレジットを消費します。考えている時間や待機中は消費しません。
          下の表はよくある使い方の例です。実際の消費量は、各機能の画面で実行前に表示されます。
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          円の目安は都度チャージ（¥{TOPUP_YEN.toLocaleString("ja-JP")} / {TOPUP_CREDITS}C）で換算しています。月額プランならこれより割安です。
          失敗した生成・学習のクレジットは返金されます。
        </p>

        <div className="mt-12 space-y-10">
          {sections.map((s) => (
            <section key={s.title}>
              <h2 className="text-lg font-bold text-foreground">{s.title}</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">{s.lead}</p>
              <div className="mt-3 overflow-hidden rounded-xl border border-border">
                <table className="w-full text-sm">
                  <tbody>
                    {s.rows.map((r) => (
                      <tr key={r.label} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-2.5 text-foreground/90">
                          {r.label}
                          {r.note && <span className="mt-0.5 block text-[11px] text-muted">{r.note}</span>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono font-semibold text-neon-pink">
                          {r.credits.toLocaleString("ja-JP")} C
                        </td>
                        <td className="hidden whitespace-nowrap px-4 py-2.5 text-right text-xs text-muted sm:table-cell">
                          {yen(r.credits)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>

        <p className="mt-12 text-xs leading-relaxed text-muted">
          実行中にもう 1 本を待たずに並列で出す場合は、追加料金がかかります（終わるのを待って出せば追加料金はかかりません）。
          クレジットの購入は{" "}
          <Link href="/#pricing" className="text-neon-pink hover:underline">
            料金プラン
          </Link>{" "}
          から。
        </p>
      </div>
    </div>
  );
}
