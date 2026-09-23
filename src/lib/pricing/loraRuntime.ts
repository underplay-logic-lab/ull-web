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
//   ※ 枚数/step はほぼ正比例（2026-09-21 実測。下の batchFactor）
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
 * === 根拠: GUI 既定条件での本番実測（2026-09-20）===
 * minimax_h3 / B300 / 1024px / rank64 / **実効バッチ1** / adamw /
 * gradient_checkpointing 無効 / **torch.compile 有効** / 実写131枚 / 200step:
 *   **1.80 s/it**
 * 保存が挟まる区間を除いた定常部で、3経路が一致している:
 *   step 130->180: 50step / 90秒 = 1.80
 *   step  63->100: 37step / 66秒 = 1.78
 *   tqdm 表示    : 1.70〜1.90
 *
 * これは GUI モードが実際に使う構成そのもの（実効バッチ1固定・compile 有効）
 * なので、逆算を挟まずそのまま基準値にできる。旧値 0.90 は「実効バッチ4 での
 * 3.60 s/it を正比例と仮定して 4 で割った逆算」で、実測の半分だった。
 *
 * 🚨 **合成データのベンチを価格の根拠にしてはいけない**。同一条件を
 * modal_lora_benchmark.py の合成24枚（アスペクト比7バケット混在）で測ると
 * **0.20 s/it** で、実写と **9倍** ずれた。画素数を揃えても実データの重さは
 * 再現できない。値付けに使う数字は必ず実ジョブのログから取ること。
 *
 * ⚠️ この式は gradient_checkpointing と torch.compile の有無を見ていない。
 * どちらも s/it を大きく動かすが、GUI モードでは両方固定（gc 無効・compile は
 * 実効バッチ1なので有効）なので、効くのは生YAML（admin 限定）だけ。
 *
 * ⚠️ minimax_h3 以外の ai-toolkit arch は実測が無く、旧表の相対順序を保った
 * まま minimax_h3 に合わせて一律スケール（x2.0）したもの。**どれも未検証**。
 *
 * ⚠️ modal_lora_worker.py 側にも同名のテーブルがある（payload に
 * cost_cap_seconds が乗らなかった場合のフォールバック）。片方だけ触らないこと。
 */
export const LORA_SPI_BASELINE: Readonly<Record<string, number>> = {
  // --- ai-toolkit ワーカー ---
  minimax_h3: 1.80, // 実測（docs §14.15）。GUI 既定条件そのもので計測した値
  // 2026-09-23 実測 0.46（実写220枚・1024px・batch1・block_compile・50step、B300、docs §14.16）。
  // 単発50stepなので 20% の安全側を乗せて 0.55。それでも旧推測 1.44 の 1/2.6。
  wan22_14b: 0.55,
  wan21: 1.24,
  // 2026-09-23 実測 0.92（実写220枚・1024px・batch1・block_compile・50step、B300、docs §14.17）。
  // 単発50stepなので 20% 上乗せで 1.10。
  // 2026-09-23 tier 確認: H200 でも 0.92（§14.26）。据え置き。
  ltx2: 1.10,
  hunyuan: 1.44,
  cogvideox: 1.44,
  qwen_image: 0.72,
  // 2026-09-23 実測 0.57（実写220枚・1024px・batch1・block_compile・50step、B300、docs §14.19）。20% 上乗せで 0.69。
  // 2026-09-23 tier 確認: H200 で 0.742（§14.26）。20% 上乗せで 0.89。
  krea2: 0.89,
  // 2026-09-23 実測 0.51（実写220枚・1024px・batch1・block_compile・50step、B300、docs §14.21）。20% 上乗せで 0.61。
  // 2026-09-23 tier 確認: RTX PRO 6000 で 0.477（§14.26、B300 より速い）。20% 上乗せで 0.57。
  anima: 0.57,
  // 2026-09-23 実測 0.27（実写220枚・1024px・batch1・block_compile・50step、B300、docs §14.20）。20% 上乗せで 0.32。
  // 2026-09-23 tier 確認: RTX PRO 6000 で 0.535（§14.26）。20% 上乗せで 0.64。
  zimage: 0.64,
  // 2026-09-23 実測 0.295（実写220枚・1024px・batch1・compile 無し・50step、B300、docs §14.18）。20% 上乗せで 0.35。
  // 2026-09-23 tier 確認: RTX PRO 6000 で 0.555（§14.26）。20% 上乗せで 0.67。
  flux2_klein_4b: 0.67,
  // --- sd-scripts ワーカー（別 tier・別スタック）---
  // 0.642 は「step 数だけ変えた2回の実行の総経過時間を連立で分離」して出した
  // 値で、下記の tqdm パースのバグとは無関係。よって据え置く。
  // 2026-09-23 実測（同一 220枚・1024px・L40S、docs §14.24/§14.25）:
  //   LoCon 無し・rank 32/16・3,490step（v6） → 定常 0.74 s/it
  //   LoCon 有り・rank 32/16・300step        → 1.21 s/it
  //   LoCon 有り・rank 64/64・3,000step      → 1.23 s/it
  // rank の寄与は 2%（誤差）。LoCon は +65% だが、同条件比較で顔の再現性が段違いだったため
  // 既定で有効（SDXL_CONV_DIM=16）。LoCon 有りの両実測を覆う 1.25。
  sdxl: 1.25,
};
export type LoraWorkerBackend = "sd_scripts" | "ai_toolkit";

/** LORA_SPI_BASELINE を測った rank。全 arch とも rank 32（docs §14.16〜14.25）。 */
export const LORA_SPI_REFERENCE_RANK = 32;

/**
 * rank が s/it に効く割合 k（arch 別、2026-09-23 追加）。
 *   rank係数 = 1 + k × (rank / 32 − 1)
 * rank 32 で必ず 1.0 なので LORA_SPI_BASELINE のアンカーはずれない。k=0 は「rank で所要秒が
 * 動かない」＝旧挙動。実測が無い arch は 0 のままにし、測れた arch から埋める。
 * 背景: 「時間が変わるのに価格が変わらない」のは歪み（ホスト指摘 2026-09-23）。
 */
export const LORA_RANK_MARGINAL: Readonly<Record<string, number>> = {
  // sd-scripts / L40S / LoCon 既定込み、同一 220枚で実測: rank 32 → 1.21 s/it、rank 64 → 1.23 s/it
  // （docs §14.24・§14.25）。rank 2倍で +2% ＝ 誤差なので 0（式は残す。他 arch で効いたら埋める）。
  sdxl: 0,
};

export function loraRankFactor(arch: string | null | undefined, rank: number | undefined): number {
  const k = LORA_RANK_MARGINAL[String(arch ?? "").trim().toLowerCase()] ?? 0;
  const r = typeof rank === "number" && Number.isFinite(rank) && rank > 0 ? rank : LORA_SPI_REFERENCE_RANK;
  return Math.max(0.25, 1 + k * (r / LORA_SPI_REFERENCE_RANK - 1));
}

/** 価格式が知っている GPU tier。knob `gpu_usd_per_hour_<tier>` と同じ綴り。 */
export type LoraGpuTier = "b300" | "b200" | "h200" | "h100" | "rtx_pro_6000" | "a100_80gb" | "l40s";

/**
 * arch 別プロファイル（2026-09-23）。実ジョブの `metadata.metrics` で測れた arch から順に埋める。
 * 無い arch は従来どおり knob（minimax_h3 基準の prep 828s + 1.33s/枚、B300）へフォールバック。
 *
 * 背景: prep の knob は minimax_h3（逆量子化＋巨大 compile）で測った固定費で、軽い arch には
 * 9倍過大だった（flux2_klein_4b: 実 124s に対し 1,120s → 50step が 692C、粗利 95%）。
 * s/it は以前から arch 別（LORA_SPI_BASELINE）だったが、prep と GPU 単価が一律だった。
 *
 * gpu: その arch を回す tier（VRAM が収まる最安、ホスト判断 2026-09-23）。ここが SSOT で、
 * dispatch payload の `gpu_tier` 経由で worker の with_options(gpu=…) に渡る。tier を変える
 * ときは必ずその tier で s/it を測り直してから（Wan2.2-S2V で B300 ≈ H100 の前例あり）。
 * 実測値の出典は docs/gpu-benchmarks.md §14.16〜。
 */
export const LORA_ARCH_PROFILE: Readonly<
  Record<string, { prepLoadS?: number; prepPerImageS?: number; gpu?: LoraGpuTier }>
> = {
  // §14.16: prep 778s（JIT 629 + latent 149 = 0.675s/枚）、VRAM 119GB → B300/B200 のまま。
  wan22_14b: { prepLoadS: 650, prepPerImageS: 0.7, gpu: "b300" },
  // §14.26（2026-09-23 tier 確認ラン）: H200 で s/it 0.92（B300 と同じ）、VRAM 86.8GB → H200。1step 原価 −36%。
  ltx2: { prepLoadS: 550, prepPerImageS: 0.5, gpu: "h200" },
  // §14.26: RTX PRO 6000 で s/it 0.555（B300 0.295 の 1.9 倍遅い）、VRAM 38GB。1step 原価 −20%、所要時間は約 2 倍。
  flux2_klein_4b: { prepLoadS: 100, prepPerImageS: 0.25, gpu: "rtx_pro_6000" },
  // §14.26: H200 で s/it 0.742（B300 0.57 の 1.3 倍）、VRAM 70.8GB。1step 原価 −17%。
  krea2: { prepLoadS: 150, prepPerImageS: 0.3, gpu: "h200" },
  // §14.26: RTX PRO 6000 で s/it 0.535（B300 0.266 の 2.0 倍）、VRAM 46.3GB。1step 原価 −15%、所要時間は約 2 倍。
  zimage: { prepLoadS: 100, prepPerImageS: 0.15, gpu: "rtx_pro_6000" },
  // §14.26: RTX PRO 6000 で s/it 0.477（B300 0.509 より速い）、VRAM 30.3GB。1step 原価 −60%。
  anima: { prepLoadS: 100, prepPerImageS: 0.2, gpu: "rtx_pro_6000" },
};

/** arch を回す GPU tier。sd-scripts 系は L40S 固定、ai-toolkit 系はプロファイル、無ければ B300。 */
export function loraArchGpuTier(arch: string | null | undefined): LoraGpuTier {
  const key = String(arch ?? "").trim().toLowerCase();
  if (loraWorkerBackend(key) === "sd_scripts") return "l40s";
  return LORA_ARCH_PROFILE[key]?.gpu ?? "b300";
}

export function gpuUsdPerHour(tier: LoraGpuTier, knobs: PricingKnobs): number {
  const map: Record<LoraGpuTier, number> = {
    b300: knobs.gpu_usd_per_hour_b300,
    b200: knobs.gpu_usd_per_hour_b200,
    h200: knobs.gpu_usd_per_hour_h200,
    h100: knobs.gpu_usd_per_hour_h100,
    rtx_pro_6000: knobs.gpu_usd_per_hour_rtx_pro_6000,
    a100_80gb: knobs.gpu_usd_per_hour_a100_80gb,
    l40s: knobs.gpu_usd_per_hour_l40s,
  };
  const v = map[tier];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : knobs.gpu_usd_per_hour_b300;
}

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
  if (loraWorkerBackend(arch) === "sd_scripts") return knobs.lora_credits_per_gpu_second_sdxl;
  // ai-toolkit 側の knob は B300 時給で導出した「B300 の 1 GPU 秒」の単価。arch を安い tier で
  // 回すときは時給比で比例縮小する（markup は据え置き）。B300 なら比 1.0 で従来どおり。
  const tier = loraArchGpuTier(arch);
  const ratio = gpuUsdPerHour(tier, knobs) / gpuUsdPerHour("b300", knobs);
  return knobs.lora_credits_per_gpu_second * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
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
  const profile = LORA_ARCH_PROFILE[String(arch ?? "").trim().toLowerCase()];
  if (profile && typeof profile.prepLoadS === "number") return profile.prepLoadS;
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

/** 画像1枚あたりの準備時間（latent キャッシュ等）。プロファイルがあればそれ、無ければ knob。 */
export function loraPrepPerImageSeconds(
  arch: string | null | undefined,
  knobs: PricingKnobs = DEFAULT_KNOBS,
): number {
  const profile = LORA_ARCH_PROFILE[String(arch ?? "").trim().toLowerCase()];
  if (profile && typeof profile.prepPerImageS === "number") return profile.prepPerImageS;
  return knobs.lora_prep_per_image_s;
}

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
  /** rank による s/it の倍率（rank 32 で 1.0）。LORA_RANK_MARGINAL 参照。 */
  rankFactor: number;
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
  /** 1 step で処理する画像枚数 = batch_size × gradient_accumulation（gas は無関係）。 */
  effectiveBatch?: number;
  /** データセットの画像枚数。prep の可変分に効く。 */
  imageCount?: number;
  /** LoRA の linear rank（network_dim）。0/不明なら基準 rank として扱う。 */
  rank?: number;
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

  // effectiveBatch = 1 step で処理する画像枚数（batch_size × gradient_accumulation）。
  // 「1ステップのうちバッチに比例する分」の割合 m を knob で持ち、
  //   係数 = (1 - m) + m × 枚数    （m=1 で正比例、m=0 でバッチ無関係）
  // バッチ1では必ず 1.0 になるので LORA_SPI_BASELINE のアンカーはずれない。
  //
  // 2026-09-21 実測（docs §14.8.1、minimax_h3 / B300 / 1024px / rank64 / gc無効 /
  // block_compile / 実写131枚）— **ほぼ正比例**:
  //   batch1 → 1.78 s/it（1.78秒/枚） / batch2 → 3.45（1.725秒/枚）
  //   batch4 → 6.52 s/it（1.63秒/枚）
  // バッチ4倍で1画像あたりの改善は9%だけ。タイマーの内訳も forward/backward が
  // 揃って約3.9倍で、バッチ1の時点で既に計算律速だった。よって m は 1.0 のまま
  // （正比例＝実測比で最大9%の過大見積もり＝安全側）。
  const effectiveBatch = clamp(finite(input.effectiveBatch, 1) || 1, 1, MAX_EFFECTIVE_BATCH);
  const batchMarginal = clamp(finite(knobs.lora_batch_marginal_ratio, 1), 0, 1);
  const batchFactor = 1 - batchMarginal + batchMarginal * effectiveBatch;

  const rankFactor = loraRankFactor(arch, input.rank);

  const secondsPerStep = spi * resolutionFactor * batchFactor * rankFactor;

  const steps = clamp(Math.round(finite(input.steps, 0)), 0, MAX_STEPS_GUARD);
  const trainSeconds = steps * secondsPerStep;

  const imageCount = clamp(Math.round(finite(input.imageCount, 0)), 0, MAX_IMAGE_COUNT);
  const prepSeconds =
    Math.max(0, finite(loraPrepLoadSeconds(arch, knobs), 0)) +
    Math.max(0, finite(loraPrepPerImageSeconds(arch, knobs), 0)) * imageCount;

  const rawTotal = prepSeconds + trainSeconds;
  const cappedByAbsMax = rawTotal > LORA_ABS_MAX_RUN_S;
  const totalSeconds = Math.min(rawTotal, LORA_ABS_MAX_RUN_S);

  return {
    spi,
    resolutionFactor,
    batchFactor,
    rankFactor,
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
