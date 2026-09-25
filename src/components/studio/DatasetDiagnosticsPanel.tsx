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
  onPrepareCrop,
  provisional = false,
  stalledCount = 0,
  onRetryStalled,
  onPrepareTrim,
  highlightPrepare = false,
}: {
  items: DiagnosticInput[];
  subjects: LoraSubject[];
  /** 足りない構図を作りに行く導線（マルチアングルタブへ切り替える）。 */
  onOpenMultiAngle?: () => void;
  /**
   * 距離軸の穴を埋める導線（2026-09-21）。ボタン自体はドロップゾーン内にも
   * あるが、165枚のサムネイル grid を挟んでいて指摘を読んだ位置からは
   * 見えない。ただし**ここで切り出しを実行はしない** — 実行ボタンが2つある
   * と「どちらが何を対象にするのか」が分からなくなるため（2026-09-21、
   * ホスト指摘）。ここは「該当被写体の元画像を選択してクロップ欄へ送る」
   * だけを行い、実行は1つのボタンに集約する。
   */
  onPrepareCrop?: (subject: string, kinds: ("face" | "upper")[]) => void;
  /**
   * キャプション解析が終わっていない＝この診断は暫定値（2026-09-21、ホスト
   * 指摘「要確認の数値がやる度に変わる」）。解析中は対象枚数が増えていくので
   * 数字が動くのは当然だが、黙っていると不信の元になるので明示する。
   */
  provisional?: boolean;
  /** 判定が走っていないのに構図が未判定のまま残っている枚数（0なら正常）。 */
  stalledCount?: number;
  /** 未判定の画像だけ構図の判定をやり直す（無料）。 */
  onRetryStalled?: () => void;
  /** 多すぎる構図（bucket）から count 枚を削除候補として選ぶ（2026-09-25。削除はユーザーが一覧で行う）。 */
  onPrepareTrim?: (subject: string, bucket: string, count: number) => void;
  /** 導線として「切り出す準備をする」を光らせるか（loraFlowStep が決める）。 */
  highlightPrepare?: boolean;
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
  // 被写体ごとに「クロップで埋まる穴」と、その構図をまとめる。
  const cropPlan = new Map<string, Set<"face" | "upper">>();
  for (const i of diag.issues) {
    if (i.fixableWith !== "smart_crop" || !i.subject || !i.cropKinds?.length) continue;
    const set = cropPlan.get(i.subject) ?? new Set<"face" | "upper">();
    for (const k of i.cropKinds) set.add(k);
    cropPlan.set(i.subject, set);
  }
  const KIND_LABEL: Record<"face" | "upper", string> = { face: "顔アップ", upper: "上半身" };
  // 多すぎる構図を減らす案（被写体ごとに、必要な枚数の多いほう）。
  const trimPlan = new Map<string, { bucket: string; count: number }>();
  for (const i of diag.issues) {
    const b = i.balance;
    if (!i.subject || !b?.trimBucket || b.trim <= 0) continue;
    const cur = trimPlan.get(i.subject);
    if (!cur || b.trim > cur.count) trimPlan.set(i.subject, { bucket: b.trimBucket, count: b.trim });
  }
  const bucketLabel = (id: string) => DIAGNOSTIC_AXES.distance.buckets.find((x) => x.id === id)?.label ?? id;

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
          {/* 赤だけでなく黄の件数も常に出す（2026-09-22、ホスト指摘）。
              「要確認1」なのにクロップのボタンが2構図を提案するのは、
              ボタンが赤・黄を問わず「クロップで埋まる穴」を拾うため。
              黄の件数が見えないと数が合わないように見える。 */}
          {warns.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
              注意 {warns.length}
            </span>
          )}
          {provisional && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
              <Loader2 size={9} className="animate-spin" />
              判定中・暫定
            </span>
          )}
          {!provisional && stalledCount > 0 && (
            <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-400">
              未判定 {stalledCount} 枚
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
                    // キャプションにその軸のタグがほとんど無い場合、0 を赤く
                    // 出すと「その構図が欠けている」と誤読される。実際は
                    // **測れていない**だけ（仰角は水平が既定で、Danbooru 系の
                    // キャプションにわざわざ書かれないのが典型）。
                    // 指摘側も同じ条件で判断を止めている（datasetDiagnostics.ts）。
                    const unmeasured = s.unique > 0 && s.unclassified[axis] / s.unique > 0.7;
                    if (unmeasured) {
                      return (
                        <div key={axis} className="flex flex-wrap items-baseline gap-x-2 text-[10px] opacity-50">
                          <span className="w-8 shrink-0 text-muted">{def.label}</span>
                          <span className="text-muted">
                            判定できません（該当するタグがほぼ無い / {s.unclassified[axis]}/{s.unique} 枚）
                          </span>
                        </div>
                      );
                    }
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
                            title="この軸のタグが無く、分類できなかった枚数です。数字が大きいときはこの軸の判定を鵜呑みにしないでください。"
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

          {/* 多すぎる構図を減らす（任意）。切り出しより先に置く（2026-09-25、ホスト指摘「削除を先にやった方が効率的」）。
              先に減らせば、必要な切り出しの枚数も減る。候補は 1 人で写っている画像だけ（2 人の画像は貴重なので残す）。 */}
          {trimPlan.size > 0 && onPrepareTrim && (
            <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2 py-1.5">
              <p className="text-[10px] leading-relaxed text-muted">
                <strong className="text-foreground">まず、多すぎる構図を減らすことを検討してください（任意）。</strong>
                先に減らすと、このあと必要な切り出しの枚数も減ります。押すと、減らす候補（その人が 1 人で写っている画像）を
                一覧で選択した状態にします。見比べて、残したいものは選択を外してから「選択した N 枚を削除」を押してください。
                似た構図・同じ服装の画像から削るのがおすすめです。
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...trimPlan.entries()].map(([subj, t]) => (
                  <button
                    key={subj}
                    type="button"
                    onClick={() => onPrepareTrim(subj, t.bucket, t.count)}
                    className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[10px] font-medium text-amber-300 transition-colors hover:bg-amber-500/20"
                  >
                    <span className="font-mono">{subj}</span> の{bucketLabel(t.bucket)}から減らす候補（約 {t.count}枚）を選ぶ
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* クロップの導線は「素材を足すしかない」ブロックの外に出す
              （2026-09-22、ホスト指摘）。「全身に偏っている」は学習回数でも
              調整できる warn なのであちらの中に入らないが、薄いほうの構図を
              引き画から切り出せば実物が増える＝そちらのほうが上位の手当て。 */}
          {cropPlan.size > 0 && onPrepareCrop && (
            <div className="space-y-1.5 rounded-lg border border-neon-violet/40 bg-neon-violet/10 px-2 py-1.5">
              <p className="text-[10px] leading-relaxed text-muted">
                <strong className="text-foreground">足りない構図は、いま持っている引き画から切り出せます。</strong>{" "}
                無料で、その場で増やせます。下のボタンを押すと、対象の元画像と切り出す構図がクロップ欄に
                自動でセットされます。
                <span className="opacity-70">
                  （「要確認」だけでなく「注意」の穴も一緒に埋めるので、赤の件数より多くの構図を提案することがあります）
                </span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...cropPlan.entries()].map(([subj, kinds]) => (
                  <button
                    key={subj}
                    type="button"
                    onClick={() => onPrepareCrop(subj, [...kinds])}
                    className={`inline-flex items-center gap-1 rounded-lg border border-neon-violet/40 bg-neon-violet/15 px-2.5 py-1 text-[10px] font-medium text-neon-violet transition-colors hover:bg-neon-violet/25${
                      highlightPrepare ? " flow-next" : ""
                    }`}
                  >
                    <Scissors size={11} />
                    <span className="font-mono">{subj}</span> の{" "}
                    {[...kinds].map((k) => KIND_LABEL[k]).join("・")} を切り出す準備をする
                  </button>
                ))}
              </div>
              <p className="text-[10px] leading-relaxed text-muted opacity-80">
                ※ 2人写っている画像からは<strong className="text-foreground">両方</strong>を切り出します。
                どちらがどの被写体かは後で作るキャプションが判定するので、狙っていない側の分も無駄になりません。
              </p>
              {cropPlan.size > 1 && (
                <p className="text-[10px] leading-relaxed text-amber-400">
                  被写体ごとに<strong>1回ずつ</strong>行ってください。押す →
                  下のクロップ欄で「切り出す」→ 戻ってもう片方を押す → もう一度「切り出す」、の順です。
                  切り出しが終わると選択は自動で解除されるので、2回目はそのまま押せます。
                </p>
              )}
            </div>
          )}

          {needMaterial > 0 && (
            <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5">
              <p className="text-[10px] leading-relaxed text-muted">
                <strong className="text-foreground">学習回数を増やしても直らない指摘があります。</strong>
                同じ画像を繰り返し見せても情報は増えないので、足りない構図の画像を追加してください。
              </p>
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
              {diag.uncaptioned} 枚は構図を判定できなかったか、どの被写体か判定できませんでした。診断はその分だけ不正確です。
            </p>
          )}

          {provisional && (
            <p className="text-[10px] leading-relaxed text-amber-400">
              構図の判定が終わっていないため、この数字はまだ動きます。全部終わってから判断してください。
            </p>
          )}
          {!provisional && stalledCount > 0 && (
            <p className="text-[10px] leading-relaxed text-red-400">
              {stalledCount} 枚は構図を判定できませんでした。この {stalledCount} 枚は上の集計に入っていません。
              {onRetryStalled && (
                <button
                  type="button"
                  onClick={onRetryStalled}
                  className="ml-1 inline-flex items-center gap-1 rounded-md border border-red-400/50 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-300 transition-colors hover:bg-red-500/20"
                >
                  🔄 判定し直す（無料）
                </button>
              )}
            </p>
          )}
          <p className="text-[10px] leading-relaxed text-muted opacity-70">
            ※ 構図は画像ごとに付けたタグ（全身・上半身・後ろ姿・座り など）を数えたものです。キャプションを作る前の
            被写体ごとの内訳は、登録した性別と特徴から推定したもので、キャプションを作ると確定します。枚数そのものは事実ですが、「目安◯枚」はまだ実測で校正されていない出発点の値です。
          </p>
        </div>
      )}
    </div>
  );
}
