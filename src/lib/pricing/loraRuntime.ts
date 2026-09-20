// LoRA 学習ジョブの「所要GPU秒」の見積もり — 課金と損切りの共通の土台。
//
// 2026-09-20: 課金方式を作り直した際に新設。旧方式は係数の掛け算
//   ceil(0.1 C/step × モデル係数 × 解像度係数 × バッチ係数 × rank係数 × steps)
// で、次の2つの問題を抱えていた:
//   (a) 学習設定を変えるたびに係数を人手で校正し直す必要があり、「設定が
//       決まらないと価格が決められない」という手詰まりを生んでいた。
//   (b) 実測で判明した arch 間の原価差（sdxl 1.4s/it を安いGPUで回す場合と
//       minimax_h3 5.0s/it を最上位GPUで回す場合で実に16倍）を、モデル係数
//       1.0 / 3.0 の2段では表現できていなかった。
//
// 新方式は「推定GPU秒 × クレジット単価」の1本:
//   推定秒 = prep(枚数) + steps × s/it(arch, 解像度, 実効バッチ)
//   ※ 実効バッチは正比例ではない（2026-09-20 実測。下の batchFactor）
//   消費C  = ceil(推定秒 × クレジット単価[worker class])
// 学習設定が変われば推定秒が変わり、価格が自動で追従する。設定値の確定を
// 待たずに価格を運用でき、実測が更新されたら下の LORA_SPI_BASELINE と
// knob を差し替えるだけで済む。
//
// ⚠️ この見積もりは課金（src/lib/loraPricing.ts）と損切り
// （src/lib/pricing/costGuard.server.ts）の **両方** が呼ぶ。以前は両者が
// 別々の式を持っており、CLAUDE.md §3 の「クレジット計算式を変えたら
// cost-guard に影響が及んでいないか必ず確認」という注意書きが必要な密結合
// だった（実際に片方を変えてもう片方が壊れた事故がある）。同じ関数を通す
// ことで、その事故クラス自体を無くしてある。
//
// クライアント（LoraStudioTab の見積り表示）も import するので "server-only"
// は付けない。GPU の物理型番・時給原価はここに一切出さない（CLAUDE.md §2
// ブランド保護）— 単価は「C/秒」に畳んだ公開 knob として渡ってくる。

import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

// Modal コンテナの 12h タイムアウトから graceful-stop 用の20分を引いた値。
// modal_lora_worker.py の LORA_ABS_MAX_RUN_S と一致させること。
// （costGuard.server.ts から移設 — 見積もりの上限として課金側でも要る。）
export const LORA_ABS_MAX_RUN_S = 12 * 60 * 60 - 20 * 60;

/**
 * LORA_SPI_BASELINE の値を実測した基準解像度。テーブルの値は
 * 「この解像度・実効バッチ1」での 1 イテレーション所要秒。
 */
export const LORA_SPI_REFERENCE_RESOLUTION = 1024;

/**
 * arch 別の s/it（秒/イテレーション）。基準解像度・実効バッチ1。
 *
 * === 2026-09-20 実測（modal_lora_benchmark.py の smoke プラン、2回）===
 * minimax_h3 / B300 / 1024px / rank32 / batch1 / prodigy /
 * gradient_checkpointing 無効 / torch.compile 有効:
 *   1回目（サンプル生成あり） 0.2329 s/it
 *   2回目（サンプル生成なし） 0.2135 s/it   ← 現行の本番設定に一致
 * 学習ステップ間の壁時計差分から算出し、生ログの tqdm（`lr:`/`loss:` を伴う
 * 行＝本番ワーカー自身の判定でも学習ステップ）とも一致。本番設定に合う
 * 2回目を採用して 0.213 とした。
 *
 * これにより docs/gpu-benchmarks.md §5 の 2026-09-06 計測（compile
 * 5.0-5.4 it/s ＝ 0.19-0.20 s/it）が正しかったと確認された。旧テーブルの
 * `minimax_h3: 5.0` は **it/s を s/it と取り違えた値**で、21倍の過大評価
 * だった。課金は推定GPU秒ベースなので、この取り違えは価格に直撃する。
 *
 * ⚠️ 実測できているのは minimax_h3 だけ。他の ai-toolkit arch は、旧テーブル
 * の相対順序（大きいモデルほど遅い、という方向自体は妥当）を保ったまま、
 * 実測点でアンカーして一律 0.213/5.0 = 0.0426 倍したもの。**どれも未検証**
 * なので、arch ごとに実測が出たら個別に差し替えること。
 *
 * sdxl は別扱い（sd-scripts ワーカー・別 GPU tier で桁が違う）。**こちらも
 * 2026-09-20 に実測済み** — L40S / 1024px / rank32 / prodigy /
 * gradient_checkpointing 無効 で、step 数だけ変えた2回の実行から連立で分離:
 *   elapsed(20step) = 56.0s、elapsed(120step) = 120.2s
 *   → s/it = (120.2-56.0)/100 = 0.642、prep = 56.0 - 20×0.642 = 43.2s
 * 旧値 1.4 は 2026-09-15 のスモーク（rank16・AdamW8bit・
 * gradient_checkpointing 有効）由来で、条件も算出方法も違っていた。
 * peak VRAM は 2回とも 17.73GB（L40S 48GB に対し 30GB の余裕）。
 *
 * ⚠️ modal_lora_worker.py 側にも同名のテーブルがある（payload に
 * cost_cap_seconds が乗らなかった場合のフォールバック）。2026-09-20 時点で
 * 全 arch 同値に揃えてあるので、片方だけ触らないこと。
 */
export const LORA_SPI_BASELINE: Readonly<Record<string, number>> = {
  // --- ai-toolkit ワーカー ---
  minimax_h3: 0.213, // ← 実測（2026-09-20, B300, 2回とも 0.21-0.23）
  wan22_14b: 0.17,
  wan21: 0.149,
  ltx2: 0.149,
  hunyuan: 0.17,
  cogvideox: 0.17,
  qwen_image: 0.085,
  krea2: 0.085,
  anima: 0.06,
  zimage: 0.051,
  flux2_klein_4b: 0.047,
  // --- sd-scripts ワーカー（別 tier・別スタック）---
  sdxl: 0.642,
};

export type LoraWorkerBackend = "sd_scripts" | "ai_toolkit";

// arch "sdxl"（illustrious_xl / juggernaut_xl プリセット、または
// custom_model_id + base_architecture="sdxl"）だけが sd-scripts ワーカー
// （modal_sdxl_lora_worker.py）へ、それ以外は ai-toolkit ワーカー
// （modal_lora_worker.py）へルーティングされる。理由は「SDXL は ai-toolkit
// だとうまく焼けなかった」という実測（ホスト、2026-09-15）で、GPU の都合
// ではない。/api/studio/lora/train の isSdxlJob と同じ判定。
//
// 課金の観点で分ける必要があるのは、2つのワーカーが別の GPU tier で回る
// 結果クレジット単価が違うため。判定の根拠はあくまでバックエンドなので、
// ルーティング条件を変えるときは route.ts と必ず揃えること。
const SD_SCRIPTS_ARCHES: ReadonlySet<string> = new Set(["sdxl"]);

export function loraWorkerBackend(arch: string | null | undefined): LoraWorkerBackend {
  return SD_SCRIPTS_ARCHES.has(String(arch ?? "").trim().toLowerCase())
    ? "sd_scripts"
    : "ai_toolkit";
}

/** ワーカーごとの「GPU 1秒あたり何クレジット課金するか」。 */
export function loraCreditsPerGpuSecond(
  arch: string | null | undefined,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): number {
  return loraWorkerBackend(arch) === "sd_scripts"
    ? knobs.lora_credits_per_gpu_second_sdxl
    : knobs.lora_credits_per_gpu_second;
}

/**
 * ワーカーごとの「枚数に依らない準備時間」。
 *
 * 2026-09-20 に backend 別へ分離した。ai-toolkit 側（MiniMax H3 等）は毎回
 * int8/nvfp4 の逆量子化を走らせるうえ torch.compile のウォームアップも重く、
 * 実測で 20 分超。sd-scripts 側にはそのどちらも無いので、同じ固定費を当てると
 * SDXL ジョブを大幅に過大請求してしまう。
 */
export function loraPrepLoadSeconds(
  arch: string | null | undefined,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): number {
  if (loraWorkerBackend(arch) === "sd_scripts") return knobs.lora_prep_load_s_sdxl;
  const base = knobs.lora_prep_load_s;
  return DEQUANTIZED_ARCHES.has(String(arch ?? "").trim().toLowerCase())
    ? base + knobs.lora_prep_dequant_s
    : base;
}

/**
 * 配布重みが量子化されていて、ロードのたびに full precision へ逆量子化する
 * 必要がある arch。これはワーカーの性質ではなく **チェックポイントの性質**
 * なので、worker backend とは別軸で持つ。
 *
 * minimax_h3 は DiT が pruned INT8 convrot、text encoder が NVFP4 AWQ で
 * 配布されており、ai-toolkit がその形式でしかロードできない（非量子化版への
 * 差し替えは 2026 年に調査済みで断念、ホスト）。逆量子化結果を Volume へ
 * bake する機構は存在するが、85.5GB の容量と引き換えに1ジョブ10分しか
 * 縮まらないため 2026-09-14 に無効化済み（`ULL_H3_BAKE=0`）。
 * つまりこの逆量子化コストは毎ジョブ恒久的に発生する。
 */
const DEQUANTIZED_ARCHES: ReadonlySet<string> = new Set(["minimax_h3"]);

// 壊れた／悪意ある YAML が桁違いの数値を持ち込んでも見積もりが発散しない
// ようにするためのガード。上限に張り付いた時点で LORA_ABS_MAX_RUN_S 側の
// 頭打ちが効くので、ここは「計算が壊れない」ことだけを担保すれば足りる。
const MAX_RESOLUTION = 4096;
const MAX_EFFECTIVE_BATCH = 64;
const MAX_STEPS_GUARD = 100_000;
const MAX_IMAGE_COUNT = 5_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const finite = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export type LoraRuntimeEstimate = {
  /** 採用した arch 別 s/it（基準解像度・バッチ1での値）。 */
  spi: number;
  /** 解像度による s/it の倍率（基準解像度で 1.0）。 */
  resolutionFactor: number;
  /** 実効バッチによる s/it の倍率（バッチ1で 1.0）。正比例ではない — §14.7。 */
  batchFactor: number;
  /** 実際の1ステップ所要秒（解像度・実効バッチ込み）。 */
  secondsPerStep: number;
  /** 純学習時間。 */
  trainSeconds: number;
  /** コンテナ起動・モデルロード + 枚数に比例する latent キャッシュ等。 */
  prepSeconds: number;
  /** prep + train（LORA_ABS_MAX_RUN_S で頭打ち）。 */
  totalSeconds: number;
  /** 頭打ちが効いたか（= 本来この設定は完走しない）。 */
  cappedByAbsMax: boolean;
  backend: LoraWorkerBackend;
};

export type LoraRuntimeInput = {
  arch: string | null | undefined;
  steps: number;
  /** データセットの最大解像度。0/不明なら基準解像度として扱う。 */
  resolution?: number;
  /** batch_size × gradient_accumulation_steps。 */
  effectiveBatch?: number;
  /** データセットの画像枚数。prep の可変分に効く。 */
  imageCount?: number;
  /**
   * arch の s/it を直接上書きする（秒/it）。同じ ai-toolkit の arch 文字列を
   * 共有しつつ実体がずっと軽いプリセット用（例: WAN 2.1 1.3B は loader class
   * を 14B と共有する）。loraModels.ts の LoraPreset.spiOverride から来る。
   */
  spiOverride?: number;
  knobs?: PricingKnobs;
};

export function loraEstimatedSeconds(input: LoraRuntimeInput): LoraRuntimeEstimate {
  const knobs = input.knobs ?? DEFAULT_KNOBS;
  const arch = String(input.arch ?? "").trim().toLowerCase();

  const spiRaw =
    typeof input.spiOverride === "number" && Number.isFinite(input.spiOverride) && input.spiOverride > 0
      ? input.spiOverride
      : (LORA_SPI_BASELINE[arch] ?? knobs.lora_spi_baseline_default);
  const spi = Math.max(0, finite(spiRaw, knobs.lora_spi_baseline_default));

  // 解像度は画素数（辺の2乗）に比例して重くなるのを基本に、実測とのズレを
  // 指数 knob で吸収する（1.0 = 画素数に正比例）。
  const resolution = clamp(Math.round(finite(input.resolution, 0)), 0, MAX_RESOLUTION);
  const exponent = clamp(finite(knobs.lora_res_scale_exponent, 1), 0, 2);
  const resolutionFactor =
    resolution > 0 ? Math.pow((resolution / LORA_SPI_REFERENCE_RESOLUTION) ** 2, exponent) : 1;

  // 実効バッチ（batch_size × grad_accum）は1オプティマイザステップあたりの
  // forward/backward 回数だが、**所要秒は正比例しない**。実測（§14.7）では
  // バッチ1で 0.213 s/it、バッチ4（かつ rank 倍）で 0.485 s/it ＝ 1画像あたり
  // はむしろ速い。バッチ1のとき GPU 使用率が平均 1.8% で遊んでいるためで、
  // まとめても時間がほとんど増えない。
  // そこで「1ステップのうちバッチに比例する分」の割合を knob で持ち、
  //   係数 = (1 - m) + m × バッチ    （m=1 で旧挙動の正比例、m=0 で無関係）
  // とする。バッチ1では必ず 1.0 になるので、LORA_SPI_BASELINE（バッチ1で実測）
  // のアンカーはずれない。
  const effectiveBatch = clamp(finite(input.effectiveBatch, 1) || 1, 1, MAX_EFFECTIVE_BATCH);
  const batchMarginal = clamp(finite(knobs.lora_batch_marginal_ratio, 1), 0, 1);
  const batchFactor = 1 - batchMarginal + batchMarginal * effectiveBatch;

  const secondsPerStep = spi * resolutionFactor * batchFactor;

  const steps = clamp(Math.round(finite(input.steps, 0)), 0, MAX_STEPS_GUARD);
  const trainSeconds = steps * secondsPerStep;

  const imageCount = clamp(Math.round(finite(input.imageCount, 0)), 0, MAX_IMAGE_COUNT);
  const prepSeconds =
    Math.max(0, finite(loraPrepLoadSeconds(arch, knobs), 0)) +
    Math.max(0, finite(knobs.lora_prep_per_image_s, 0)) * imageCount;

  const rawTotal = prepSeconds + trainSeconds;
  const cappedByAbsMax = rawTotal > LORA_ABS_MAX_RUN_S;
  const totalSeconds = Math.min(rawTotal, LORA_ABS_MAX_RUN_S);

  return {
    spi,
    resolutionFactor,
    batchFactor,
    secondsPerStep,
    trainSeconds,
    prepSeconds,
    totalSeconds,
    cappedByAbsMax,
    backend: loraWorkerBackend(arch),
  };
}

/**
 * 見積もりに対する余裕係数。実測のばらつきぶん（CLAUDE.md §0「タイムアウトは
 * 多めに」）。損切りの下限（costGuard.server.ts）と、下の loraMaxSteps() が
 * 「12時間に収まるか」を判定するときの両方で同じ値を使う。
 */
export const LORA_RUNTIME_CUSHION = 1.3;

/**
 * この設定で 12時間のコンテナ上限に収まる最大 step 数。
 *
 * UI のスライダー上限（LORA_MAX_STEPS = 20,000）は「扱いやすさ」で決めた
 * 内側の値で、**本当の壁はこちら**。解像度・実効バッチ・枚数を上げていけば
 * この値は下がるので、生 YAML のように極端な設定を組める経路では、投入前に
 * ここで弾く（/api/studio/lora/train）。推定秒ベースなので、実測が更新されれば
 * 上限も自動で追従する。
 *
 * 余裕係数ぶんを引いてあるのは、見積もりちょうどで 12h に張り付く設定を通すと
 * 「課金だけして完走しない」ジョブになるため。
 */
export function loraMaxSteps(input: Omit<LoraRuntimeInput, "steps">): number {
  const probe = loraEstimatedSeconds({ ...input, steps: 1 });
  const budget = LORA_ABS_MAX_RUN_S / LORA_RUNTIME_CUSHION - probe.prepSeconds;
  if (!(probe.secondsPerStep > 0) || budget <= 0) return 0;
  return Math.max(0, Math.floor(budget / probe.secondsPerStep));
}

/**
 * 課金しうる上限クレジット。
 *
 * 「コンテナのハード上限（LORA_ABS_MAX_RUN_S）を超えて GPU を使うことは
 * そもそも出来ない」ので、それ以上は課金しようがない、という素直な天井。
 * 生 YAML がパース不能で API まで到達した場合の請求額にもこれを使う。
 *
 * ⚠️ 推定秒が LORA_ABS_MAX_RUN_S を超える設定は、本来は「頭打ちにして安く
 * 請求する」のではなく **受け付けない** のが正しい（完走しないので課金だけ
 * して失敗する）。Stage 1 の実測で s/it が確定したら、明示的な拒否に変える
 * こと。今は旧実装と同じく頭打ちにしてある。
 */
export function loraCreditWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  const rate = Math.max(
    knobs.lora_credits_per_gpu_second,
    knobs.lora_credits_per_gpu_second_sdxl,
  );
  return Math.ceil(LORA_ABS_MAX_RUN_S * Math.max(0, finite(rate, 0)));
}
