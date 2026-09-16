// Single source of truth for every tunable pricing / cost-guard number in the
// product. Each knob has a hardcoded DEFAULT here (== the value that used to be
// scattered across loraPricing.ts / angleStudio.ts / cinematicPricing.ts /
// modal_lora_worker.py / the angle route) and, at runtime, an admin-editable
// override row in the `pricing_knobs` table (see knobs.server.ts).
//
// This file has NO imports and NO "server-only" guard: the client bundles it
// as the fallback the Studio tabs show before /api/studio/pricing responds,
// and the migration seeds `pricing_knobs` from KNOB_META below.

export type KnobCategory = "feature_credits" | "lora_formula" | "cost_guard" | "rates";

export type KnobKey =
  // --- feature_credits (public) ---
  | "image_generate"
  | "angle_turbo_per_angle"
  | "angle_pro_per_angle"
  | "angle_ref_multiplier_per_sub"
  | "angle_priority_parallel_surcharge"
  | "cinematic_speed"
  | "cinematic_standard"
  | "cinematic_cinema_master"
  | "director_per_second_fast"
  | "director_per_second_quality"
  | "director_min_credits"
  | "director_priority_parallel_surcharge"
  | "upscale_per_mp"
  | "upscale_min_credits"
  | "upscale_priority_parallel_surcharge"
  | "upscale_mult_power"
  | "upscale_cascade_mult_2stage"
  | "upscale_cascade_mult_3stage"
  | "upscale_video_base_credits"
  | "upscale_video_per_frame"
  | "upscale_video_min_credits"
  | "upscale_video_mult_res_2k"
  | "upscale_video_mult_res_4k"
  // --- lora_formula (public) ---
  | "lora_per_step"
  | "lora_mult_model_heavy"
  | "lora_mult_res_1024"
  | "lora_mult_res_1280"
  | "lora_mult_batch_2"
  | "lora_mult_batch_4"
  | "lora_mult_rank_64"
  // --- cost_guard (server-only) ---
  | "angle_time_per_credit_s"
  | "angle_cold_start_grace_s"
  | "upscale_time_per_credit_s"
  | "upscale_cold_start_grace_s"
  | "upscale_batch_max_seconds"
  | "upscale_video_time_per_credit_s"
  | "upscale_video_cold_start_grace_s"
  | "lora_cost_guard_multiplier"
  | "lora_margin_target"
  | "lora_floor_prep_s"
  | "lora_safety_limit_s"
  | "lora_spi_baseline_default"
  // --- rates (server-only) ---
  | "credit_to_jpy"
  | "gpu_jpy_per_hour_b300"
  | "usd_jpy_rate";

export type PricingKnobs = Record<KnobKey, number>;

type KnobMeta = {
  value: number;
  label: string;
  category: KnobCategory;
  unit: string;
  description: string;
  /** Exposed to the browser via GET /api/studio/pricing. */
  isPublic: boolean;
};

// Order here is the order the admin Pricing tab renders rows within a section.
export const KNOB_META: Record<KnobKey, KnobMeta> = {
  // ---------------------------------------------------------------- feature
  image_generate: {
    value: 1,
    label: "画像生成",
    category: "feature_credits",
    unit: "C",
    description: "1枚あたりの消費クレジット（/api/generate）",
    isPublic: true,
  },
  // 2026-09-09: turbo/pro の 2 モード廃止。angle_turbo_per_angle は未使用（DB 行は
  // 残置・admin 非表示化は任意）。単価は angle_pro_per_angle に一本化。
  angle_turbo_per_angle: {
    value: 2,
    label: "Multi-Angle Turbo（廃止・未使用）",
    category: "feature_credits",
    unit: "C/構図",
    description: "（廃止）turbo/pro 統合前の名残。課金は angle_pro_per_angle を使用。",
    isPublic: false,
  },
  angle_pro_per_angle: {
    // 2026-09-09: 12C ≈ ¥20/構図（credit_to_jpy 1.66）。B300 実測でコールドスタート
    // + 1構図(60s)でも黒字になる下限。最低 3 構図（MIN_ANGLES）と併せて原価割れを
    // 防ぐ。値は /admin の Pricing で調整可（¥25 なら 15C 等）。
    value: 12,
    label: "Multi-Angle（1構図）",
    category: "feature_credits",
    unit: "C/構図",
    description: "1構図あたりの消費クレジット（40ステップ / 最低3構図）",
    isPublic: true,
  },
  angle_ref_multiplier_per_sub: {
    // Multi-Reference（Pro）: サブ参照 1 枚ごとに per-構図 単価へ加える係数。
    // 係数 = 1 + これ × サブ枚数。B300 実測でサブ 3 枚 = 生成時間 ×3.0
    // （per-step 463ms→1373ms）→ 0.7 で係数 3.1、粗利 ~69% を維持。
    // per-構図 単価 = ceil(angle_pro_per_angle × 係数)。
    value: 0.7,
    label: "Multi-Angle サブ参照 加算係数",
    category: "feature_credits",
    unit: "×/枚",
    description: "サブ参照1枚ごとに 1構図単価へ乗せる係数（係数 = 1 + これ×枚数）。0で無料。",
    isPublic: true,
  },
  angle_priority_parallel_surcharge: {
    // 2026-09-14: 「実行中でも並列で今すぐ実行」を選んだ時の追加料金。
    // 順番待ち（無料・既定）は完了済みの温かいコンテナを再利用するが、並列は
    // 新規コンテナのコールドスタートを追加で1回発生させる。その原価を
    // angle_cold_start_grace_s（600s、実測ベース）× gpu_jpy_per_hour_b300
    // (¥1125/h) ÷ credit_to_jpy(1.66) ≈ 113C に、他の単価と同じ3倍markup
    // （director系の導出と同じ慣例）を掛けた概算値。実測ではなく理論値なので
    // 実際の並列利用が増えたら admin で調整すること。
    value: 340,
    label: "Multi-Angle 並列実行 追加料金",
    category: "feature_credits",
    unit: "C",
    description: "実行中のジョブを待たず並列で今すぐ実行する場合の追加コールドスタート分の上乗せ。",
    isPublic: true,
  },
  cinematic_speed: {
    value: 1,
    label: "Cinematic Speed Mode",
    category: "feature_credits",
    unit: "C",
    description: "1本あたりの消費クレジット（4ステップ / 512px）",
    isPublic: true,
  },
  cinematic_standard: {
    value: 2,
    label: "Cinematic Standard Mode",
    category: "feature_credits",
    unit: "C",
    description: "1本あたりの消費クレジット（4ステップ / 768px）",
    isPublic: true,
  },
  cinematic_cinema_master: {
    value: 5,
    label: "Cinematic Cinema Master",
    category: "feature_credits",
    unit: "C",
    description: "1本あたりの消費クレジット（20ステップ / 1024px）",
    isPublic: true,
  },
  director_per_second_fast: {
    // ULL Cinematic Director "Fast"モード: VDN-H3 8step蒸留(stage-dmd-step-250、
    // 無音仕様)。2026-09-14 B300実機（480x864）で elapsed=396.1s → GPU時給
    // ¥1125/h換算で原価≈¥124/15秒（¥8.25/秒）。原価の約3倍 ≈ ¥24.75/秒 ÷
    // credit_to_jpy(1.66) ≈ 14.9C/秒。
    //
    // 旧 director_per_second(0.6)は2026-09-09〜13の間、B300実機60秒=638.6sの
    // 原価計算を10倍誤って(¥19.9とすべきところ¥199.6)算出した値で、実際の
    // 原価に対し大幅な過小課金だった（本番60秒生成で36C≈¥60課金 vs 実原価
    // ¥187〜200）。2026-09-13/14のVDN-H3導入・実測し直しでこの誤りを解消。
    value: 14.9,
    label: "Cinematic Director Fast（秒あたり）",
    category: "feature_credits",
    unit: "C/秒",
    description: "Fastモード（8step蒸留・無音）の合計尺1秒あたり消費クレジット",
    isPublic: true,
  },
  director_per_second_quality: {
    // ULL Cinematic Director "Quality"モード: VDN-H3 50step非蒸留
    // (stage-b-step-2000、音声あり)。2026-09-13 B300実機（1024px相当）で
    // elapsed=681.3s → 原価≈¥213/15秒（¥14.19/秒）。原価の約3倍 ≈
    // ¥42.6/秒 ÷ 1.66 ≈ 25.7C/秒。
    value: 25.7,
    label: "Cinematic Director Quality（秒あたり）",
    category: "feature_credits",
    unit: "C/秒",
    description: "Qualityモード（50step非蒸留・音声あり）の合計尺1秒あたり消費クレジット",
    isPublic: true,
  },
  director_min_credits: {
    value: 5,
    label: "Cinematic Director 最低課金",
    category: "feature_credits",
    unit: "C",
    description: "1本あたりの最低消費クレジット（秒課金の下限）",
    isPublic: true,
  },
  director_priority_parallel_surcharge: {
    // 2026-09-14: 「実行中でも並列で今すぐ実行」を選んだ時の追加料金。
    // directorPollDeadlineS() の固定オーバーヘッド分（+200s、実測ベース）を
    // 他の priority_parallel_surcharge 系と同じ導出方法で概算:
    // 200s × gpu_jpy_per_hour_b300(¥1125/h) ÷ credit_to_jpy(1.66) ≈ 38C
    // （原価） × 3倍markup ≈ 115C。理論値なので、実際の利用が増えたら
    // admin で調整すること。
    value: 115,
    label: "Cinematic Director 並列実行 追加料金",
    category: "feature_credits",
    unit: "C",
    description: "実行中のジョブを待たず並列で今すぐ実行する場合の追加コールドスタート分の上乗せ。",
    isPublic: true,
  },
  upscale_per_mp: {
    // 超解像スタジオ（SeedVR2）: 出力の 100 万画素あたりの消費クレジット。
    // credits = max(upscale_min_credits, ceil(これ × 出力MP × モデル係数))。
    // B300 実測: 出力 ~5MP を warm ~20s / cold ~60s。3 C/MP で 2K プリセット
    // （~5MP）≈ 15C ≈ ¥25、cold 原価 ~¥19・warm ~¥6 → 黒字。
    value: 3,
    label: "超解像（100万画素あたり）",
    category: "feature_credits",
    unit: "C/MP",
    description: "出力の100万画素あたりの消費クレジット（× モデル係数）",
    isPublic: true,
  },
  upscale_min_credits: {
    // 小さい出力（×2 等）でもコールドスタートを償却できる下限。
    value: 8,
    label: "超解像 最低クレジット",
    category: "feature_credits",
    unit: "C",
    description: "1枚あたりの消費クレジット下限（コールドスタート償却）",
    isPublic: true,
  },
  upscale_priority_parallel_surcharge: {
    // 2026-09-14: 「実行中でも並列で今すぐ実行」を選んだ時の追加料金。
    // angle_priority_parallel_surcharge と同じ導出方法（CLAUDE.md §6）:
    // upscale_cold_start_grace_s(180s) × gpu_jpy_per_hour_b300(¥1125/h) ÷
    // credit_to_jpy(1.66) ≈ 34C（原価） × 3倍markup ≈ 100C。理論値なので
    // 実際の利用が増えたら admin で調整すること。
    value: 100,
    label: "超解像 並列実行 追加料金",
    category: "feature_credits",
    unit: "C",
    description: "実行中のジョブを待たず並列で今すぐ実行する場合の追加コールドスタート分の上乗せ。",
    isPublic: true,
  },
  upscale_mult_power: {
    // 2026-09-10 撤廃・未使用。8K も倍率モードと同じ純 MP 課金にした
    // （純 MP 課金がすでに「大きい出力ほど高い」を実現しており、8K だけの
    // 上乗せは実効倍率と釣り合わなかった）。DB 行は残置。
    value: 1.0,
    label: "超解像 パワーティア係数（廃止・未使用）",
    category: "feature_credits",
    unit: "×",
    description: "（廃止）8K も倍率モードも純 MP 課金。この値は使われない。",
    isPublic: false,
  },
  upscale_cascade_mult_2stage: {
    // 2026-09-12: ×4 モードは内部で ×2→×4 の2段カスケードにして高画質化
    // （単発直行よりディテールがシャープ。B300 実測は要参照だが理論値
    // ~1.25倍）。実 GPU 秒が伸びる分をクレジットにも反映する。
    value: 1.3,
    label: "超解像 カスケード係数（2段）",
    category: "feature_credits",
    unit: "×",
    description: "×4 モード（×2→×4 の2段カスケード）に乗せる追加係数。",
    isPublic: true,
  },
  upscale_cascade_mult_3stage: {
    // ×8 モードは ×2→×4→×8 の3段カスケード。B300 実測（yukipas.png,
    // 2026-09-11）: 単発108.77s vs カスケード157.46s = 1.45倍。少し余裕を
    // 見て1.5に設定。
    value: 1.5,
    label: "超解像 カスケード係数（3段）",
    category: "feature_credits",
    unit: "×",
    description: "×8 モード（×2→×4→×8 の3段カスケード）に乗せる追加係数。",
    isPublic: true,
  },
  upscale_video_base_credits: {
    // 2026-09-17 実機実測（CLAUDE.md §1）: 動画超解像はモデルロード等の
    // 固定オーバーヘッドがコストの大半を占め、フレーム数への依存はごく
    // わずか（48f=17.8GB〜1800f=19.2GBとVRAMはほぼ横ばい、時間も
    // 固定+0.3s/frame程度）。HD/L40S実測(72frame・210.86s、うち固定分
    // ~189s)から: 固定費 = 189s/3600×$1.95/h×¥150/$ ÷ credit_to_jpy(1.66)
    // ×3倍markup ≈ 27.8C。既存の upscale_video_mult_res_2k/4k
    // （プリセット別GPU単価込み実測係数）を掛けるとHD=28C/2K≈68C/4K≈139C
    // となり、2K/4Kの固定費実測（68.0C/142.7C）とほぼ一致する。
    value: 28,
    label: "動画超解像（固定費・HD基準）",
    category: "feature_credits",
    unit: "C",
    description: "モデルロード等の固定オーバーヘッド分（HD基準、他プリセットはmult_res_2k/4kが乗る）",
    isPublic: true,
  },
  upscale_video_per_frame: {
    // 2026-09-17 実機実測により大幅減額（旧値2 → 0.05）。旧式は
    // per_frame×frameCountの完全比例課金だったが、フレーム数はVRAM・時間の
    // 軸ではない（上記 upscale_video_base_credits 参照）ため、旧値のままだと
    // 15秒HD動画で実コスト$0.16に対し$10.00を課金する約62倍のマークアップに
    // なっていた（2026-09-17ホスト指摘で発覚）。実測の真の限界コスト
    // （0.3s/frame @ L40S $1.95/h）に3倍markupを乗せた0.044Cに安全マージンを
    // 見て0.05に設定。
    value: 0.05,
    label: "動画超解像（1フレームあたり・限界費用分）",
    category: "feature_credits",
    unit: "C/frame",
    description: "出力フレーム数あたりの追加消費クレジット（固定費に対するわずかな上乗せ、× モデル係数）",
    isPublic: true,
  },
  upscale_video_min_credits: {
    value: 20,
    label: "動画超解像 最低クレジット",
    category: "feature_credits",
    unit: "C",
    description: "1本あたりの消費クレジット下限（コールドスタート償却）",
    isPublic: true,
  },
  upscale_video_mult_res_2k: {
    // 2026-09-16/17 実機再計測（CLAUDE.md §1）: プリセット別GPU tier導入
    // （HD=L40S $1.95/h・2K=H200 $4.54/h・4K=B300 $7.10/h）に伴い、旧係数
    // （MP比のみ・単一GPU前提）を「GPU単価込みの実コスト比」に更新。
    // 同一入力（72フレーム・3秒）でHD=210.86s($0.1142)・2K=220.55s($0.2782)
    // ・4K=288.53s(12MP上限ケース、$0.5690) → HD比: 2K=2.44 / 4K=4.98。
    // 旧値(2.25)はMPだけを見ていたため、実際はGPU単価差も乗るこの水準まで
    // 過小評価していた。
    value: 2.44,
    label: "動画超解像 2Kプリセット係数",
    category: "feature_credits",
    unit: "×",
    description: "2Kプリセット選択時にper_frameへ掛ける係数（HD=1.0基準、GPU単価差込み実測）",
    isPublic: true,
  },
  upscale_video_mult_res_4k: {
    // 上記2kと同時実測。旧値(2.9)はMPのみの比率で、GPU単価差
    // （B300 $7.10/h vs HD側L40S $1.95/h）を反映しておらず原価割れに
    // 近い水準だった。実測5.0弱まで引き上げる。
    value: 4.98,
    label: "動画超解像 4Kプリセット係数",
    category: "feature_credits",
    unit: "×",
    description: "4Kプリセット選択時にper_frameへ掛ける係数（HD=1.0基準、GPU単価差込み実測）",
    isPublic: true,
  },
  // ------------------------------------------------------------- lora_formula
  lora_per_step: {
    value: 0.1,
    label: "LoRA 基本単価",
    category: "lora_formula",
    unit: "C/step",
    description: "ceil(単価 × 各係数 × steps) の基本単価",
    isPublic: true,
  },
  lora_mult_model_heavy: {
    value: 3.0,
    label: "LoRA モデル係数（動画系）",
    category: "lora_formula",
    unit: "×",
    description: "minimax_h3 / wan21 / hunyuan など動画 DiT の倍率。それ以外は 1.0。",
    isPublic: true,
  },
  lora_mult_res_1024: {
    value: 1.5,
    label: "LoRA 解像度係数（≥1024px）",
    category: "lora_formula",
    unit: "×",
    description: "データセット最大解像度が 1024〜1279px のときの倍率",
    isPublic: true,
  },
  lora_mult_res_1280: {
    value: 2.0,
    label: "LoRA 解像度係数（≥1280px）",
    category: "lora_formula",
    unit: "×",
    description: "データセット最大解像度が 1280px 以上のときの倍率",
    isPublic: true,
  },
  lora_mult_batch_2: {
    value: 1.5,
    label: "LoRA バッチ係数（実効≥2）",
    category: "lora_formula",
    unit: "×",
    description: "batch_size × grad_accum が 2〜3 のときの倍率",
    isPublic: true,
  },
  lora_mult_batch_4: {
    value: 2.0,
    label: "LoRA バッチ係数（実効≥4）",
    category: "lora_formula",
    unit: "×",
    description: "batch_size × grad_accum が 4 以上のときの倍率",
    isPublic: true,
  },
  lora_mult_rank_64: {
    value: 1.2,
    label: "LoRA Rank 係数（≥64）",
    category: "lora_formula",
    unit: "×",
    description: "network.linear（LoRA dim）が 64 以上のときの倍率",
    isPublic: true,
  },
  // -------------------------------------------------------------- cost_guard
  angle_time_per_credit_s: {
    value: 10,
    label: "Angle 損切り：1C あたり猶予秒",
    category: "cost_guard",
    unit: "s/C",
    description: "max_allowed_time = 消費C × これ + コールドスタート猶予",
    isPublic: false,
  },
  angle_cold_start_grace_s: {
    // コールド時の初回 forward は Qwen の RoPE 複素演算が Inductor 非対応で
    // eager フォールバックし、B300 でも ~500s かかる（一過性）。旧 300 だと
    // コールドの大ジョブが生成前に損切り自爆しうるため 600 に引き上げ。
    value: 600,
    label: "Angle 損切り：コールドスタート猶予",
    category: "cost_guard",
    unit: "s",
    description: "コンテナ起動 + モデルロード + 初回 forward warmup の固定猶予",
    isPublic: false,
  },
  upscale_time_per_credit_s: {
    value: 4,
    label: "超解像 損切り：1C あたり猶予秒",
    category: "cost_guard",
    unit: "s/C",
    description: "max_allowed_time = 消費C × これ + コールドスタート猶予",
    isPublic: false,
  },
  upscale_cold_start_grace_s: {
    // ComfyUI 起動 + SeedVR2 7B（16.5GB）ロード + 初回 forward warmup。
    // B300 実測でコールド 1 枚目 ~40-60s。
    value: 180,
    label: "超解像 損切り：コールドスタート猶予",
    category: "cost_guard",
    unit: "s",
    description: "ComfyUI 起動 + SeedVR2 重みロード + 初回 forward の固定猶予",
    isPublic: false,
  },
  upscale_batch_max_seconds: {
    // 2026-09-12: 複数画像バッチ機能。1コンテナ内で温まったまま順番に処理する
    // ので、コールドスタート償却はバッチ全体で1回だけ（upscale_cold_start_grace_s
    // を1回だけ足す）。合計推定秒数がこれを超えるバッチは受け付けない
    // （src/lib/upscaleStudio.ts の upscaleBatchEstimatedSeconds 参照）。
    // Modal 側の強制 timeout（SEEDVR2_BATCH_TIMEOUT_HARD_CAP_S 既定45分）より
    // 十分小さく取ってあるので、見積もりがブレても Modal 側の保険が効く。
    value: 1800,
    label: "超解像 バッチ：合計処理秒数の上限",
    category: "cost_guard",
    unit: "s",
    description: "1バッチの推定合計処理秒数がこれを超えたら受け付けない。",
    isPublic: false,
  },
  upscale_video_time_per_credit_s: {
    // 2026-09-17 実機事故で発覚（CLAUDE.md §1・§0「タイムアウトは多めに」）:
    // 課金式を「per_frameに完全比例」から「固定費+わずかなフレーム比例分」へ
    // 修正した際、消費クレジット数が904C→51Cへ激減した結果、この値を媒介に
    // した max_allowed_time（消費C×これ+コールドスタート猶予）も
    // 904×6=5424s(94分)から51×6=306s(5分)へ連動して激減し、実際には正常
    // 進行中だったHDジョブ（実測10分超）が「処理時間の上限を超えました」で
    // 誤って強制終了・返金される事故が発生した。ホスト判断（2026-09-17）:
    // 仕組み自体は残す（TRELLIS workerクラッシュループ31分無駄の教訓——
    // 本当の暴走を止める必要はある）が、かなり大きく緩める。
    // 6→45へ引き上げ、HD最小ケース（28C・実測10分超）でも25分の猶予
    // （2.5倍以上のマージン）、他プリセットはさらに大きな余裕を確保する。
    value: 45,
    label: "動画超解像 損切り：1C あたり猶予秒",
    category: "cost_guard",
    unit: "s/C",
    description: "max_allowed_time = 消費C × これ + コールドスタート猶予",
    isPublic: false,
  },
  upscale_video_cold_start_grace_s: {
    // ComfyUI 起動 + SeedVR2 重みロード + VHS(VideoHelperSuite) ノード初回
    // 実行の固定猶予。実測前なので画像（180s）より余裕を見て 240s。
    value: 240,
    label: "動画超解像 損切り：コールドスタート猶予",
    category: "cost_guard",
    unit: "s",
    description: "ComfyUI起動+SeedVR2重みロード+VHSノード初回実行の固定猶予",
    isPublic: false,
  },
  lora_cost_guard_multiplier: {
    value: 1.4,
    label: "LoRA 損切り：余裕倍率",
    category: "cost_guard",
    unit: "×",
    description: "クレジット按分秒 × これ = 予測壁時計の停止閾値。1.0 で厳格な損益分岐。",
    isPublic: false,
  },
  lora_margin_target: {
    value: 0.7,
    label: "LoRA 損切り：粗利ターゲット",
    category: "cost_guard",
    unit: "率",
    description: "0.7 = GPU 原価を売上の 70% までに抑える（粗利 30%）",
    isPublic: false,
  },
  lora_floor_prep_s: {
    value: 2700,
    label: "LoRA 損切り：prep 下駄秒",
    category: "cost_guard",
    unit: "s",
    description: "純学習時間に加算する latent キャッシュ / チェックポイント余裕",
    isPublic: false,
  },
  lora_safety_limit_s: {
    value: 18000,
    label: "LoRA 損切り：0C ジョブ上限",
    category: "cost_guard",
    unit: "s",
    description: "クレジット 0（生 YAML パース不能）ジョブの絶対上限秒",
    isPublic: false,
  },
  lora_spi_baseline_default: {
    value: 2.5,
    label: "LoRA 損切り：未知 arch の s/it",
    category: "cost_guard",
    unit: "s/it",
    description: "arch 別実測テーブルに無いモデルの 1 イテレーション所要秒",
    isPublic: false,
  },
  // -------------------------------------------------------------------- rates
  credit_to_jpy: {
    value: 1.66,
    label: "クレジット売上単価",
    category: "rates",
    unit: "円/C",
    description: "最安サブスク単価。損益計算・Cost Simulator の売上換算に使用。",
    isPublic: false,
  },
  gpu_jpy_per_hour_b300: {
    value: 1125,
    label: "GPU 時給（B300）",
    category: "rates",
    unit: "円/h",
    description: "LoRA 損切りのクレジット按分秒の分母",
    isPublic: false,
  },
  usd_jpy_rate: {
    value: 150,
    label: "為替レート（USD/JPY）",
    category: "rates",
    unit: "円/$",
    description: "Cost Simulator の Modal 原価（USD 建て）換算レートの既定値",
    isPublic: false,
  },
};

export const DEFAULT_KNOBS: PricingKnobs = Object.fromEntries(
  (Object.entries(KNOB_META) as [KnobKey, KnobMeta][]).map(([k, m]) => [k, m.value]),
) as PricingKnobs;

export const PUBLIC_KNOB_KEYS: KnobKey[] = (Object.entries(KNOB_META) as [KnobKey, KnobMeta][])
  .filter(([, m]) => m.isPublic)
  .map(([k]) => k);

// Merge a partial override map (from the DB or the /api/studio/pricing
// response) onto the hardcoded defaults. Non-finite / missing values fall
// through to the default so a bad row can never zero-out a price.
export function resolveKnobs(overrides?: Partial<Record<string, number>> | null): PricingKnobs {
  const out = { ...DEFAULT_KNOBS };
  if (overrides) {
    for (const key of Object.keys(DEFAULT_KNOBS) as KnobKey[]) {
      const v = overrides[key];
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    }
  }
  return out;
}

// Worst-case LoRA credit ceiling — recomputed from the defaults so it tracks
// any change to the seed values (0.1 * 3.0 * 2.0 * 2.0 * 1.2 * 5000 = 7200).
export function loraCreditWorstCase(knobs: PricingKnobs = DEFAULT_KNOBS): number {
  const LORA_MAX_STEPS = 5000;
  return Math.ceil(
    knobs.lora_per_step *
      knobs.lora_mult_model_heavy *
      knobs.lora_mult_res_1280 *
      knobs.lora_mult_batch_4 *
      knobs.lora_mult_rank_64 *
      LORA_MAX_STEPS,
  );
}
