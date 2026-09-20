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
  | "director_qwen_script_credits"
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
  | "lora_credits_per_gpu_second"
  | "lora_credits_per_gpu_second_sdxl"
  | "lora_prep_load_s"
  | "lora_prep_load_s_sdxl"
  | "lora_prep_dequant_s"
  | "lora_prep_per_image_s"
  | "lora_res_scale_exponent"
  | "lora_batch_marginal_ratio"
  | "lora_spi_baseline_default"
  // 旧「係数の掛け算」方式の残骸（2026-09-20 廃止・未使用。DB 行は残置）
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
  | "alert_low_margin_percent"
  // --- rates (server-only) ---
  | "credit_to_jpy"
  | "gpu_usd_per_hour_b300"
  | "gpu_usd_per_hour_b200"
  | "gpu_usd_per_hour_h200"
  | "gpu_usd_per_hour_h100"
  | "gpu_usd_per_hour_rtx_pro_6000"
  | "gpu_usd_per_hour_a100_80gb"
  | "gpu_usd_per_hour_a100_40gb"
  | "gpu_usd_per_hour_l40s"
  | "gpu_usd_per_hour_a10"
  | "gpu_usd_per_hour_l4"
  | "gpu_usd_per_hour_t4"
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
  director_qwen_script_credits: {
    // Advanced（Qwen3.8-27B-abliteratedによる台本自動生成、2026-09-18導入・
    // 同日中に設計変更）使用時の追加課金。当初は動画生成本体（B300）とは
    // 別のGPUコンテナ（H100/A100-80GB）を起動する設計だったが、二重
    // コールドスタートを避けるため同一B300コンテナ内で実行する方式に変更した
    // （modal_wan_animate_blackwell.py::_generate_director_script）。
    // 2026-09-18 実機計測（cinematic_smoke_advanced、fastモード相当・15秒・
    // yukipas画像）: 総所要591.7s、うちComfyUI動画生成が442.36s（ComfyUI自身の
    // "Prompt executed"ログ） → 台本生成ぶんの追加B300稼働 ≈ 149.3s。
    // B300 gpu_jpy_per_hour_b300(¥1125/h) × 149.3/3600 ≈ ¥46.7（原価） ×
    // 3倍markup ≈ ¥140 ÷ credit_to_jpy(1.66) ≈ 84C。単発実測のため、実運用
    // データが増えたら再校正すること（CLAUDE.md §0）。
    value: 84,
    label: "Cinematic Director Advanced（Qwen台本生成）",
    category: "feature_credits",
    unit: "C",
    description: "Advancedモード（Qwenによる台本自動生成）使用時の追加消費クレジット",
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
    // 2026-09-17 GPU tier切り替え（HD: L40S→RTX PRO 6000）に伴い再計算
    // （CLAUDE.md §1「全機能を対象にしたB300代替の洗い出し」）。
    // RTX PRO 6000実測2点（74frame/114.92s, 362frame/488.84s、$3.03/h）から
    // 線形回帰: 固定費18.84s・限界費用1.298s/frame →
    // credit_to_jpy(1.66)/usd_jpy(150)/3倍markup換算で固定費4.30C
    // （旧L40S基準の4.31Cとほぼ同値・維持）・per_frame 0.30C/frame
    // （旧0.37Cから19%減、RTX PRO 6000がL40Sより速いため）。
    value: 4.30,
    label: "動画超解像（固定費・HD基準）",
    category: "feature_credits",
    unit: "C",
    description: "モデルロード等の固定オーバーヘッド分（HD基準、他プリセットはmult_res_2k/4kが乗る）",
    isPublic: true,
  },
  upscale_video_per_frame: {
    // 2026-09-17 GPU tier切り替え（HD: L40S→RTX PRO 6000）に伴い再計算。
    // 上記 upscale_video_base_credits のコメント参照——RTX PRO 6000実測
    // 2点（74frame/114.92s, 362frame/488.84s）からの線形回帰で
    // 限界費用1.298s/frame、旧L40S基準(2.52s/frame)よりかなり軽い。
    // ⚠️ 2点のみからの外挿である点は変わらず、実績データが増えたら再校正。
    value: 0.30,
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
    // 2026-09-17 GPU tier切り替え（HD: L40S→RTX PRO 6000、2K: H200→RTX
    // PRO 6000）に伴い再計算（CLAUDE.md §1）。両プリセットとも同一GPUに
    // なったため、74フレーム同一条件でのクレジット目安比を実測: HD≈26.2C
    // ・2K≈55.0C → 比率2.10。旧値(2.44)はHD=L40S/2K=H200という異なるGPU
    // 前提だったため、GPU統一後の実態に合わせて引き下げる。
    // ⚠️ 74frame基準の比率で、362frame基準では2.25とやや異なる（固定費/
    // 限界費用の構成比がプリセットで違うため単一係数では完全には表現でき
    // ない構造的な限界）。72-74frame基準を採用するのは旧値の算出方法との
    // 一貫性を優先したため。
    value: 2.10,
    label: "動画超解像 2Kプリセット係数",
    category: "feature_credits",
    unit: "×",
    description: "2Kプリセット選択時にper_frameへ掛ける係数（HD=1.0基準、GPU単価差込み実測）",
    isPublic: true,
  },
  upscale_video_mult_res_4k: {
    // 2026-09-17 HD側のGPU切り替え（L40S→RTX PRO 6000でHDが安くなった）
    // に伴い再計算。4K自体はB300のまま変わらず（VRAM135.1GBでB300一択）。
    // 72フレーム同一条件でのクレジット目安比: HD≈25.6C(新RTX PRO 6000)・
    // 4K≈154.3C(B300) → 比率6.02。旧値(4.98)はHD側がL40Sだった頃の比率で、
    // HDが安くなった分、相対的に4Kの倍率が上がる（4K自体の実測は変わって
    // いない）。⚠️ 4Kは72frame単発データしかなく、長尺での再現性は未検証。
    value: 6.02,
    label: "動画超解像 4Kプリセット係数",
    category: "feature_credits",
    unit: "×",
    description: "4Kプリセット選択時にper_frameへ掛ける係数（HD=1.0基準、GPU単価差込み実測）",
    isPublic: true,
  },
  // ------------------------------------------------------------- lora_formula
  //
  // 2026-09-20: 「係数の掛け算」方式（lora_per_step × モデル × 解像度 ×
  // バッチ × rank × steps）を廃止し、「推定GPU秒 × クレジット単価」方式へ
  // 移行した。式の実体と arch 別 s/it は src/lib/pricing/loraRuntime.ts。
  //   消費C = ceil( (prep_load + prep_per_image×枚数 + steps×s/it×解像度×バッチ)
  //                 × credits_per_gpu_second )
  lora_credits_per_gpu_second: {
    // ai-toolkit ワーカー（modal_lora_worker.py）で回る arch の単価。
    //
    // 2026-09-20: **原価ベース（3倍markup）に統一**（ホスト判断）。
    //   B300 $7.5/h × usd_jpy 150 = ¥1,125/h = ¥0.3125/GPU秒
    //   × 3.0 markup ÷ credit_to_jpy 1.66 = 0.5648 C/GPU秒
    //
    // それまでは「計測の修正が黙って価格を動かさない」ため据え置き点を採って
    // いたが、サンプル生成の停止で固定費を 60% 削れた（1,395秒 → 551秒）ので、
    // その分を値下げとして出す形に切り替えた。代表ジョブ（minimax_h3 /
    // 1024px / 画像30枚 / 1210step）は 545C → 459C。
    //
    // この単価で fal の Wan2.2 動画LoRA trainer（$0.004/step）と比べると、
    // 2000step で ¥920 対 ¥1,200（-23%）、3000step で ¥1,120 対 ¥1,800
    // （-38%）。step 数が増えるほど有利になるのは、うちが固定費主体で
    // 限界費用が小さいため。
    //
    // ⚠️ markup を動かすときは credit_to_jpy（= クレジットの実売単価）も
    // 見直すこと。1.66 は最上位サブスクの額面単価で、日次ログインボーナスと
    // Polar の決済手数料を織り込んだ実質単価はこれより2割ほど低い。
    value: 0.5648,
    label: "LoRA クレジット単価（ai-toolkit）",
    category: "lora_formula",
    unit: "C/GPU秒",
    description:
      "推定GPU秒に掛けて消費クレジットを出す単価。ai-toolkit ワーカーで回る全 arch（SDXL以外）。",
    isPublic: true,
  },
  lora_credits_per_gpu_second_sdxl: {
    // sd-scripts ワーカー（modal_sdxl_lora_worker.py）で回る arch="sdxl"
    // （illustrious_xl / juggernaut_xl）の単価。ai-toolkit では品質が出ない
    // という実測でこちらへ分けてあり、結果として一段安い GPU tier で回る。
    //
    // 2026-09-20 の実測（loraRuntime.ts の LORA_SPI_BASELINE 参照）で、推定秒が
    // 1,998 → 824 と半分以下になった。原価3倍に揃えるなら 0.1468 だが、それだと
    // 代表ジョブが 183C → 122C と33%の値下げになる。
    //
    // ホスト判断（2026-09-20）: **値下げはしない。**SDXL は実測で fal の Flux
    // LoRA trainer（2000step で ¥720〜1,500）に対し 2000step ¥292 と既に1/3以下
    // で、これ以上下げても競合比の見え方は変わらない。0.222 は価格据え置き点
    // （824秒 × 0.222 ≒ 183C ＝ 従来と同額）で、markup は約 4.5倍になる。
    // ai-toolkit 側（3.0倍）より厚いが、原価ではなく価値で取る形
    // （CLAUDE.md §0「よそでは出来ないことをやる。その分の対価はきちんと取る」）。
    value: 0.222,
    label: "LoRA クレジット単価（sd-scripts / SDXL）",
    category: "lora_formula",
    unit: "C/GPU秒",
    description: "同上。SDXL系（illustrious / juggernaut）は sd-scripts ワーカーで回るため別単価。",
    isPublic: true,
  },
  lora_prep_load_s: {
    // ai-toolkit ワーカーの、枚数に依らない固定準備時間。
    //
    // 2026-09-20 実測（modal_lora_benchmark.py smoke / minimax_h3 / B300 /
    // 1024px / 画像8枚 / 40step）: 全体 1,404.5秒 のうち、学習ステップ本体は
    // 40 × 0.2329 ≒ 9秒。残り **約1,395秒がすべて固定費**だった。内訳は
    //   - int8(DiT) + nvfp4(TE) の逆量子化 … 約570秒（毎回。bake は
    //     2026-09-14 にホスト判断で無効化済み）
    //   - torch.compile のウォームアップ
    //   - 学習前のベースラインサンプル生成（+ 別 shape の専用コンパイル）
    //   - 学習後の最終サンプル生成（sample_every = steps）… 約460秒と推定
    //   - コンテナ起動・モデルロード・VAE ロード
    //
    // 2026-09-20 の2回目の smoke（サンプル生成を止めた後＝現行の本番設定）で
    // 再計測。全体 559.9秒 のうち学習本体は 40 × 0.2135 ≒ 8.5秒で、固定費は
    // 551秒。1回目（サンプル生成あり）の 1,395秒 から **844秒・60%削減**された。
    // その551秒を、逆量子化ぶん（lora_prep_dequant_s = 270）とそれ以外
    // （モデル/VAE ロード + torch.compile ウォームアップ + 保存処理 = 280）に
    // 分けてある。
    //
    // ⚠️ 実測は minimax_h3 のみ。compile ウォームアップはモデルの大きさに依存
    // するので、軽い arch（flux2_klein_4b 等）では 280 より小さいはず＝それら
    // を過大請求している可能性が残る。arch 別に実測したら分割すること。
    // ⚠️ 270/280 の切り分けは、1回目のログのタイムスタンプから逆量子化を
    // 約270秒と見積もった上での配分で、2回目単独では両者を分離できていない。
    // 合計 550秒 の方が実測として確か。
        // 2026-09-20（夜）実測で更新: 本番フルランの prep 内訳は
    //   model load（逆量子化含む） 640.6s / latent キャッシュ 120.9s /
    //   first-step JIT 99.1s = 合計 860.7s（docs §14.13）。
    // 逆量子化ぶん（270）を差し引き、モデル化していなかった first-step JIT を
    // ここへ含めて 370 + 99 ≒ 470 とした。旧値 280 は過小だった。
value: 470,
    label: "LoRA 準備時間（固定分・ai-toolkit）",
    category: "lora_formula",
    unit: "s",
    description:
      "compile ウォームアップ・サンプル生成・モデルロード等、枚数にも step 数にも依らない固定オーバーヘッド。",
    isPublic: true,
  },
  lora_prep_dequant_s: {
    // 配布重みが量子化されている arch（現状 minimax_h3 のみ）が、ロードの
    // たびに払う full precision への逆量子化コスト。DiT(int8 convrot) と
    // text encoder(nvfp4 AWQ) の2回ぶん。
    //
    // 恒久的な固定費として扱う。非量子化版への差し替えは調査済みで断念
    // （ai-toolkit が量子化版しかロードできない）、逆量子化結果の bake も
    // 2026-09-14 に無効化済み（85.5GB の Volume 容量に対し 1ジョブ10分の
    // 短縮では見合わないとのホスト判断）。
    //
    // ⚠️ この 270 は lora_prep_load_s との配分値であって、単独で実測した値
    // ではない（そちらのコメント参照）。両方を足した 550秒 が実測。
    value: 270,
    label: "LoRA 準備時間（逆量子化ぶん）",
    category: "lora_formula",
    unit: "s",
    description:
      "量子化配布された重み（現状 minimax_h3 のみ）をロード時に full precision へ戻すコスト。該当 arch にのみ加算。",
    isPublic: true,
  },
  lora_prep_load_s_sdxl: {
    // sd-scripts ワーカー（SDXL）の固定準備時間。
    //
    // 2026-09-20 実測: step 数だけ変えた2回（20step=56.0s / 120step=120.2s）の
    // 連立から prep = 43.2 秒。少し余裕を見て 45。
    // ai-toolkit 側の 550 秒（= 280 + 逆量子化 270）と桁が違うのは、sd-scripts
    // には逆量子化も torch.compile ウォームアップも無いため。backend ごとに
    // prep を分ける設計判断が正しかったことを裏づけている。
    value: 45,
    label: "LoRA 準備時間（固定分・sd-scripts / SDXL）",
    category: "lora_formula",
    unit: "s",
    description: "SDXL系（sd-scripts ワーカー）の固定オーバーヘッド。2026-09-20 実測。",
    isPublic: true,
  },
  lora_prep_per_image_s: {
    // latent キャッシュのうち、枚数に比例する分（限界費用）。
    //
    // 2026-09-20 実測: 8枚の latent キャッシュ合計が 51.1秒。ただし経過時間の
    // 推移を見ると 1枚目に約50秒（VAE ロードとウォームアップ）が集中し、
    // 2〜8枚目の7枚は合計約1秒。つまり **限界費用は 0.14秒/枚程度**で、
    // 見かけの平均 6.38s/it は固定費を頭割りしただけの数字だった。
    // 50秒側は lora_prep_load_s に含めてある。
    //
    // ⚠️ 合成データ（全て 1024×1024 = 1バケット）での実測。実データは
    // アスペクト比が混ざりバケットが増えるので、これより大きくなり得る。
    // なお画像のリサイズ・再エンコードは CPU 関数
    // （ingest_and_optimize_dataset_cpu）で GPU 起動前に済むため、ここには
    // 乗らない。
        // 2026-09-20（夜）実測で更新: 実写131枚の latent キャッシュが 120.9秒
    //   = 0.92秒/枚（docs §14.13）。旧値 0.15 は合成データ8枚（全て同一
    // アスペクト比＝1バケット）から出した値で、実データの6倍の過小評価だった。
value: 0.9,
    label: "LoRA 準備時間（1枚あたり）",
    category: "lora_formula",
    unit: "s/枚",
    description: "latent キャッシュのうちデータセット枚数に比例する分（限界費用）",
    isPublic: true,
  },
  lora_res_scale_exponent: {
    // s/it は画素数（辺の2乗）に比例するのを基本とし、実測とのズレをこの
    // 指数で吸収する。1.0 = 画素数に正比例。attention が トークン数に対して
    // 二次で効く分、実測では 1.0 より大きくなる可能性がある。
    // ⚠️ Stage 1 で 768 / 1024 / 1280 の3点を測って回帰で確定させること。
    value: 1.0,
    label: "LoRA 解像度スケール指数",
    category: "lora_formula",
    unit: "×",
    description: "s/it = 基準値 × (解像度²/1024²)^これ。1.0 で画素数に正比例。",
    isPublic: true,
  },
  lora_batch_marginal_ratio: {
    // 1ステップの所要秒のうち「実効バッチ（batch_size × grad_accum）に比例
    // する分」の割合。1.0 で旧挙動（正比例）、0 でバッチを上げても所要秒が
    // 増えない。s/it = 基準値 × 解像度係数 × ((1-これ) + これ × 実効バッチ)。
    //
    // 2026-09-20 実測（docs/gpu-benchmarks.md §14.7）で、正比例という前提が
    // 誤りだと判明した:
    //   実効バッチ1 / rank32 → 0.2135 s/it（1画像あたり 0.213秒）
    //   実効バッチ4 / rank64 → 0.485  s/it（1画像あたり 0.121秒）
    // バッチもrankも上げているのに1画像あたりはむしろ速い。バッチ1のとき
    // GPU 使用率が平均 1.8% しかなく（§14.2）、GPU が遊んでいるのでまとめても
    // 時間がほとんど増えないため。正比例のままだとバッチを上げたジョブを
    // 最大で倍近く過大請求し、品質に有利な設定へのペナルティになっていた。
    //
    // 0.42 はこの2点を (1-m) + m×B で結んだ値（0.485/0.2135 = 2.272 = 1+3m）。
    // ⚠️ 2点しかなく、しかも条件が完全には揃っていない（バッチ1側は rank32
    // かつ torch.compile 有効、バッチ4側は rank64 かつ compile 無効）。どちらの
    // 差もバッチ4側を相対的に重く見せる向きなので、**真の m は 0.42 より小さい**
    // ＝この値は過大請求側に倒れている。安全側なのでこのまま採用するが、
    // 同一条件（同 rank・同 compile）でバッチだけを 1/2/4/8 と振った実測が
    // 出たら回帰で置き換えること。CLAUDE.md §0「少数の実測から法則を逆算
    // しない」に照らし、これは暫定値の扱い。
        // 🚨 2026-09-20（夜）: 0.42 は撤回。根拠にしていた「実効バッチ1で0.213 /
    // バッチ4で0.485」という実測が、ベンチの s/it 計測バグによる偽の値だった
    // （docs §14 冒頭の警告）。実効バッチが所要秒にどう効くかは**現在まったく
    // 未測定**なので、1.0（正比例＝過大側）へ戻す。測れたら改めて下げること。
value: 1.0,
    label: "LoRA 実効バッチの限界比率",
    category: "lora_formula",
    unit: "×",
    description:
      "1ステップのうち実効バッチに比例する割合。1.0で正比例（旧挙動）、0でバッチを上げても所要秒が変わらない。",
    isPublic: true,
  },
  lora_spi_baseline_default: {
    // 2026-09-20: cost_guard から lora_formula へ移動し公開化した。旧方式では
    // 損切り計算だけが使っていたが、新方式では課金式そのものの入力なので
    // クライアント（見積り表示）にも渡す必要がある。
    //
    // 同日さらに 2.5 → 0.3 へ修正。2.5 は LORA_SPI_BASELINE が旧スケール
    // （it/s を s/it と取り違えた値）だった頃のフォールバックで、テーブルを
    // 実測値（0.051〜0.233）へ入れ替えた際に取り残されていた。そのままだと
    // 未知 arch（＝ユーザーのカスタムモデル）が、最も重い minimax_h3 の
    // 10倍の s/it で見積もられる。
    // 0.3 は既知で最も重い minimax_h3(0.233) をやや上回る値。未知のモデルは
    // 重い可能性があるので、過小請求・損切りの早撃ちより過大側へ倒す。
    // 2026-09-20（夜）さらに 0.3 → 0.65。ベンチのバグ是正で
    // LORA_SPI_BASELINE の最重量（minimax_h3）が 0.213 → 0.55 になり、
    // 「未知 arch は既知で最も重いものをやや上回る値にする」という上の意図が
    // 逆転していた（未知の方が安く見積もられる状態）。カスタムモデルは最も
    // 予測がつかない相手なので、過大側へ倒す原則をここで維持する。
    value: 0.65,
    label: "LoRA 未知 arch の s/it",
    category: "lora_formula",
    unit: "s/it",
    description: "loraRuntime.ts の arch 別実測テーブルに無いモデルの 1 イテレーション所要秒",
    isPublic: true,
  },
  // --- 以下は旧「係数の掛け算」方式の残骸。2026-09-20 に廃止・未使用。
  //     admin から消すと DB 行との対応が崩れるので残置し、非公開にしてある。
  lora_per_step: {
    value: 0.1,
    label: "LoRA 基本単価（廃止・未使用）",
    category: "lora_formula",
    unit: "C/step",
    description: "（廃止）推定GPU秒ベースへ移行。loraRuntime.ts 参照。",
    isPublic: false,
  },
  lora_mult_model_heavy: {
    value: 3.0,
    label: "LoRA モデル係数（廃止・未使用）",
    category: "lora_formula",
    unit: "×",
    description: "（廃止）arch 別の実測 s/it テーブル（loraRuntime.ts）に置き換え。",
    isPublic: false,
  },
  lora_mult_res_1024: {
    value: 1.5,
    label: "LoRA 解像度係数 ≥1024px（廃止・未使用）",
    category: "lora_formula",
    unit: "×",
    description: "（廃止）lora_res_scale_exponent による連続式に置き換え。",
    isPublic: false,
  },
  lora_mult_res_1280: {
    value: 2.0,
    label: "LoRA 解像度係数 ≥1280px（廃止・未使用）",
    category: "lora_formula",
    unit: "×",
    description: "（廃止）lora_res_scale_exponent による連続式に置き換え。",
    isPublic: false,
  },
  lora_mult_batch_2: {
    value: 1.5,
    label: "LoRA バッチ係数 ≥2（廃止・未使用）",
    category: "lora_formula",
    unit: "×",
    description: "（廃止）実効バッチは所要秒に正比例するものとして直接掛ける。",
    isPublic: false,
  },
  lora_mult_batch_4: {
    value: 2.0,
    label: "LoRA バッチ係数 ≥4（廃止・未使用）",
    category: "lora_formula",
    unit: "×",
    description: "（廃止）実効バッチは所要秒に正比例するものとして直接掛ける。",
    isPublic: false,
  },
  lora_mult_rank_64: {
    value: 1.2,
    label: "LoRA Rank 係数（廃止・未使用）",
    category: "lora_formula",
    unit: "×",
    description:
      "（廃止）LoRA アダプタは基盤モデルに対して十分小さく、rank は所要秒をほとんど動かさないため課金要素から外した。",
    isPublic: false,
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
    // 2026-09-20 廃止・未使用。損切りの arch-floor が、課金と同じ
    // loraEstimatedSeconds()（prep を lora_prep_load_s / _sdxl /
    // _dequant / _per_image で明示的に積む）を通すようになったため、
    // 「純学習時間に一律で足す下駄」という概念自体が無くなった。
    // DB 行は残置。
    value: 2700,
    label: "LoRA 損切り：prep 下駄秒（廃止・未使用）",
    category: "cost_guard",
    unit: "s",
    description: "（廃止）prep は lora_prep_* knob で明示的に見積もるようになった。",
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
  alert_low_margin_percent: {
    // 実稼働ログ（管理画面「実稼働ログ & 粗利監視」タブ）で、直近24時間の
    // ジョブのうち粗利率がこの値を下回る（原価割れ=マイナスも含む）件数を
    // アラートバナーで表示する閾値（2026-09-18導入）。3倍markup想定なら
    // 定常時の粗利率は概ね60〜70%台になる設計なので、30%はかなり緩め
    // （早期警戒用）の初期値 — 運用しながら調整すること。
    value: 30,
    label: "粗利アラート閾値",
    category: "cost_guard",
    unit: "%",
    description: "この粗利率を下回るジョブを「低粗利」として実稼働ログのアラートに表示する",
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
  // GPU時給はUSD建てで持ち、円換算は必ず usd_jpy_rate を経由して都度計算する
  // （2026-09-18、旧設計を修正）。旧 gpu_jpy_per_hour_b300 は円を直接ハード
  // コードしており、為替が動くたびに全GPU分の値を手で直す必要があった
  // （ホスト指摘）。Modal自体の課金もUSD建てなので、GPU単価はUSD（Modal側の
  // 値上げ/値下げでのみ変わる）と為替レート（市況でのみ変わる）を分離するのが
  // 正しい——為替が動いた時に触るのは usd_jpy_rate 一箇所だけで済む。
  gpu_usd_per_hour_b300: {
    value: 7.5,
    label: "GPU 時給（B300, USD）",
    category: "rates",
    unit: "$/h",
    description: "LoRA 損切りのクレジット按分秒の分母。実稼働ログの原価計算にも使用。",
    isPublic: false,
  },
  // 以下、実稼働ログの原価・粗利計算用（2026-09-18導入）。B300以外のGPUに
  // 実ジョブを振り分けている機能（超解像HD/2K等）が正しく安く計上されるよう
  // 追加した。値は GpuCostReferenceCard.tsx の $/h 一覧をそのまま採用。
  gpu_usd_per_hour_b200: {
    value: 6.25,
    label: "GPU 時給（B200, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_h200: {
    value: 4.54,
    label: "GPU 時給（H200, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_h100: {
    value: 3.95,
    label: "GPU 時給（H100, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_rtx_pro_6000: {
    value: 3.03,
    label: "GPU 時給（RTX PRO 6000, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_a100_80gb: {
    value: 2.5,
    label: "GPU 時給（A100 80GB, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_a100_40gb: {
    value: 2.1,
    label: "GPU 時給（A100 40GB, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_l40s: {
    value: 1.95,
    label: "GPU 時給（L40S, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_a10: {
    value: 1.1,
    label: "GPU 時給（A10, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_l4: {
    value: 0.8,
    label: "GPU 時給（L4, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
    isPublic: false,
  },
  gpu_usd_per_hour_t4: {
    value: 0.59,
    label: "GPU 時給（T4, USD）",
    category: "rates",
    unit: "$/h",
    description: "実稼働ログの原価計算用",
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

// loraCreditWorstCase() は 2026-09-20 に src/lib/pricing/loraRuntime.ts へ移動
// した（新方式では「コンテナのハード上限秒 × クレジット単価」という、見積もり
// 式と同じ土台から導かれる値になったため）。このファイルは loraRuntime.ts から
// import される側なので、ここに置くと循環参照になる。
