"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, Scissors, Stethoscope, Wand2 } from "lucide-react";
import {
  analyzeDataset,
  DIAGNOSTIC_AXES,
  type DiagnosticAxis,
  type DiagnosticInput,
} from "@/lib/datasetDiagnostics";
import type { LoraSubject } from "@/lib/loraCaptionSpec";

// データセット構成の自動診断パネル（2026-09-21）。
// 動機と実データでの検証は src/lib/datasetDiagnostics.ts のヘッダ参照。
// 学習を始める前に「この構成だと誰がどう弱くなるか」を出すのが目的で、
// オートモード（ユーザーの入力が画像だけ）でのクレーム防止が本題。

export function DatasetDiagnosticsPanel({
  items,
  subjects,
  onOpenMultiAngle,
  onSmartCrop,
  smartCropCandidateCount = 0,
  smartCropBusy = false,
}: {
  items: DiagnosticInput[];
  subjects: LoraSubject[];
  /** 足りない構図を作りに行く導線（マルチアングルタブへ切り替える）。 */
  onOpenMultiAngle?: () => void;
  /**
   * 距離軸の穴を埋める導線（2026-09-21）。ボタン自体はドロップゾーン内にも
   * あるが、165枚のサムネイル grid を挟んだ**上**にあるため、指摘を読んだ
   * 位置からは見えない。指摘のすぐ横にも出す。
   */
  onSmartCrop?: () => void;
  smartCropCandidateCount?: number;
  smartCropBusy?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const diag = useMemo(() => analyzeDataset(items, subjects), [items, subjects]);

  if (diag.totalImages === 0 || diag.subjects.length === 0) return null;

  const errors = diag.issues.filter((i) => i.level === "error");
  const warns = diag.issues.filter((i) => i.level === "warn");
  const needMaterial = diag.issues.filter((i) => i.notFixableByRepeats).length;
  // Multi-Angle Studio で作れる穴があるか（カメラ由来の軸＝距離・向き・仰角）。
  const angleFixable = diag.issues.filter((i) => i.fixableWith === "multi_angle").length;
  // 手持ちの引き画から切り出せる穴（距離軸）。無料・即時なので先に出す。
  const cropFixable = diag.issues.filter((i) => i.fixableWith === "smart_crop").length;

  return (
    <div className="rounded-xl border border-neon-violet/30 bg-neon-violet/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-[11px] font-medium text-neon-violet">
          <Stethoscope size={13} />
          データセット構成の診断
          {errors.length > 0 && (
            <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-400">
              要確認 {errors.length}
            </span>
          )}
          {errors.length === 0 && warns.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
              {warns.length}
            </span>
          )}
          {errors.length === 0 && warns.length === 0 && (
            <span className="rounded-full bg-neon-pink/15 px-2 py-0.5 text-[10px] font-semibold text-neon-pink">
              問題なし
            </span>
          )}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          {/* --- 被写体ごとの構成表 --- */}
          <div className="space-y-2">
            {diag.subjects.map((s) => (
              <div key={s.trigger} className="rounded-lg border border-border/60 bg-background/60 p-2">
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-mono text-[11px] font-semibold text-foreground">{s.trigger}</span>
                  <span className="text-[10px] text-muted">
                    {s.unique} 枚
                    {s.exposure !== s.unique && (
                      <>
                        {" "}
                        ・ 露出 {s.exposure}
                        {diag.totalExposure > 0 && (
                          <>（{Math.round((s.exposure / diag.totalExposure) * 100)}%）</>
                        )}
                      </>
                    )}
                  </span>
                </div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {(Object.keys(DIAGNOSTIC_AXES) as DiagnosticAxis[]).map((axis) => {
                    const def = DIAGNOSTIC_AXES[axis];
                    return (
                      <div key={axis} className="flex flex-wrap items-baseline gap-x-2 text-[10px]">
                        <span className="w-8 shrink-0 text-muted">{def.label}</span>
                        {def.buckets.map((b) => {
                          const n = s.axes[axis][b.id] ?? 0;
                          return (
                            <span
                              key={b.id}
                              className={
                                n === 0 ? "text-red-400" : n <= 2 ? "text-amber-400" : "text-foreground"
                              }
                            >
                              {b.label}
                              <span className="ml-0.5 font-mono">{n}</span>
                            </span>
                          );
                        })}
                        {s.unclassified[axis] > 0 && (
                          <span
                            className="text-muted opacity-60"
                            title="キャプションにこの軸のタグが無く、分類できなかった枚数です。数字が大きいときはこの軸の判定を鵜呑みにしないでください。"
                          >
                            未分類{s.unclassified[axis]}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* --- 指摘 --- */}
          {diag.issues.length > 0 ? (
            <div className="space-y-1">
              {diag.issues.map((i, k) => (
                <p
                  key={k}
                  className={`flex items-start gap-1.5 text-[10px] leading-relaxed ${
                    i.level === "error" ? "text-red-400" : "text-amber-400"
                  }`}
                >
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                  <span>
                    {i.subject && <span className="font-mono">{i.subject}: </span>}
                    {i.message}
                    {i.notFixableByRepeats ? (
                      <span className="ml-1 text-muted">［学習回数では直りません／素材を足してください］</span>
                    ) : (
                      <span className="ml-1 text-muted">［学習回数で調整できます］</span>
                    )}
                  </span>
                </p>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted">構成の偏りは見つかりませんでした。</p>
          )}

          {needMaterial > 0 && (
            <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5">
              <p className="text-[10px] leading-relaxed text-muted">
                <strong className="text-foreground">学習回数を増やしても直らない指摘があります。</strong>
                同じ画像を繰り返し見せても情報は増えないので、足りない構図の画像を追加してください。
              </p>
              {cropFixable > 0 && onSmartCrop && (
                <>
                  <p className="text-[10px] leading-relaxed text-muted">
                    このうち <strong className="text-foreground">距離（顔アップ・バスト・上半身）</strong>{" "}
                    の穴は、すでに取り込んである引き画から{" "}
                    <strong className="text-foreground">無料で・その場で</strong> 切り出せます。
                  </p>
                  <button
                    type="button"
                    onClick={onSmartCrop}
                    disabled={smartCropBusy || smartCropCandidateCount === 0}
                    className="inline-flex items-center gap-1 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-2.5 py-1 text-[10px] font-medium text-neon-violet transition-colors hover:bg-neon-violet/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {smartCropBusy ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Scissors size={11} />
                    )}
                    ✂️ スマートクロップで切り出す
                    {smartCropCandidateCount > 0 ? `（元画像 ${smartCropCandidateCount} 枚）` : ""}
                  </button>
                </>
              )}
              {angleFixable > 0 && onOpenMultiAngle && (
                <>
                  <p className="text-[10px] leading-relaxed text-muted">
                    このうち <strong className="text-foreground">距離・向き・仰角</strong>{" "}
                    の穴は、手持ちの1枚から マルチアングル で作れます（8方向・仰角4段・寄り引き3段）。
                    生成した画像をこのデータセットに足してください。
                  </p>
                  <button
                    type="button"
                    onClick={onOpenMultiAngle}
                    className="inline-flex items-center gap-1 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-2.5 py-1 text-[10px] font-medium text-neon-violet transition-colors hover:bg-neon-violet/20"
                  >
                    <Wand2 size={11} />
                    🎭 マルチアングルで足りない構図を作る
                  </button>
                </>
              )}
              <p className="text-[10px] leading-relaxed text-muted opacity-70">
                ※ 姿勢（座り・寝）と背景は、カメラを動かしても変わりません。必要な場合は別途用意してください。
              </p>
            </div>
          )}

          {diag.uncaptioned > 0 && (
            <p className="text-[10px] text-amber-400">
              {diag.uncaptioned} 枚はキャプションが空か、どの被写体か判定できませんでした。診断はその分だけ不正確です。
            </p>
          )}

          <p className="text-[10px] leading-relaxed text-muted opacity-70">
            ※ この集計はキャプションのタグを数えたものです。枚数そのものは事実ですが、「目安◯枚」はまだ実測で校正されていない出発点の値です。
          </p>
        </div>
      )}
    </div>
  );
}
