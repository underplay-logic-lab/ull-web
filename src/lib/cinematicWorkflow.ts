import "server-only";
import type { CinematicMode } from "@/lib/cinematicPricing";
import { cinematicMegapixels, cinematicSafeDimensions } from "@/lib/cinematicPricing";

// The "Cinematic Video" tab's ComfyUI API-format graph — MiniMax H3 (BF16,
// image-to-audio/video) running on the Blackwell/B300 Modal deployment (see
// modal_wan_animate_blackwell.py's WanAnimateBlackwell.custom_workflow).
// Validated end-to-end against that deployment before being ported here —
// node ids/wiring mirror the working payload used to measure ~26.8s warm /
// ~4.75s per step at steps=4. Deliberately does NOT expose "MiniMax H3"
// anywhere client-facing (filename_prefix included) — see the branding
// decision behind this tab's "Cinematic Video" name.
//
// 2026-09-13 実障害（Cinematic Director、根本原因を特定するまで2回再発）:
// 元々は ImageScaleToTotalPixels（megapixels + resolution_steps=16 の動的
// サイズ決定、旧 node "119"）→ GetImageSize（旧 node "120"）で
// MiniMaxH3ImageToVideo の width/height を実画像から再導出していた。これは
// 「resolution_steps の倍数」にしか丸めず、実際にモデルが要求する条件を
// 満たさない場合があった。
//
// 途中「first_frame の実アスペクト比とズレているのでは」という誤った仮説
// で明示的リサイズを試したが直らず、最終的に ComfyUI 本体のノード実装
// （comfy_extras/nodes_minimax_h3.py, v0.33.3）のソースを直接確認して
// 判明した真因: `_empty_av_latent` が単に `height // 16` / `width // 16`
// で latent サイズを作るだけ（+1オフセット等は一切ない）。patchify
// （2ピクセル単位）が要求するのはこの latent が偶数であること、つまり
// 「width/height が32の倍数であること」だけ（ノード自身が widget に
// `step: 32` と明記している通り）。cinematicPricing.ts の floorTo16 の
// 丸め式が間違っていた（「ピクセル ≡ 16 (mod 32)」という誤った条件を実測
// 1点から誤って逆算していた）のが真因で、first_frame 側は無関係だった
// （first_frame はモデル側が内部で "disabled"＝伸縮リサイズして width/height
// に合わせる設計なので、生の LoadImage 出力をそのまま渡してよい）。
// Advanced モード（Qwen台本自動生成、2026-09-18追加）で、B300ワーカー側が
// 生成した台本を差し込むノードid。route.ts と modal_wan_animate_blackwell.py
// の両方から参照される契約値なので定数化しておく（Python側は文字列として
// 別途 "105:104" を渡す — ここを変更したら Python 側の呼び出し元も揃える）。
export const CINEMATIC_PROMPT_NODE_ID = "105:104";

const WORKFLOW_TEMPLATE = {
  // 2026-09-14: core "SaveVideo" -> ComfyUI-VideoHelperSuite の
  // VHS_VideoCombine に差し替え（ComfyUI v0.33.3 -> v0.35.1 アップグレードに
  // 伴う対応。v0.33.3を選んでいた理由だった「masterのSaveVideo一時バグ」を
  // 回避する目的、CLAUDE.md §1参照）。images/audioを直接受け取れるため
  // 旧 105:91 (CreateVideo) 経由は不要。
  // 2026-09-18 実障害修正: VHS_VideoCombine（ComfyUI-VideoHelperSuite）が
  // MiniMax H3 の AUDIO 出力を正しく扱えず、動画は正常でも音声トラックが
  // 一切乗らない無音動画になっていた（実機診断で確定 — VDN-H3/EasyCache/
  // SageAttention/チェックポイント自体はいずれも無関係と実測で切り分け
  // 済み、この結合ノードだけが原因だった）。ComfyUI 標準の CreateVideo +
  // SaveVideo に戻す（元々 v0.33.3 時代の SaveVideo 一時バグを避けるために
  // VHS_VideoCombine を採用していたが、v0.35.1 の現在は解消済みと実機
  // 確認済み）。
  "91": {
    inputs: {
      images: ["105:10", 0],
      audio: ["105:23", 0],
      fps: 24,
      bit_depth: "auto",
      color_space: "sRGB",
    },
    class_type: "CreateVideo",
    _meta: { title: "Create Video" },
  },
  "92": {
    inputs: {
      video: ["91", 0],
      filename_prefix: "cinematic_video",
      format: "mp4",
      codec: "h264",
    },
    class_type: "SaveVideo",
    _meta: { title: "Save Video" },
  },
  "114": {
    inputs: { image: "__REFERENCE_IMAGE__" },
    class_type: "LoadImage",
    _meta: { title: "Load Image" },
  },
  "105:11": {
    inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
  "105:24": {
    inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
  "105:23": {
    inputs: { samples: ["105:14", 0], vae: ["105:24", 0] },
    class_type: "VAEDecodeAudio",
    _meta: { title: "VAE Decode Audio" },
  },
  "105:10": {
    inputs: { samples: ["105:14", 0], vae: ["105:11", 0] },
    class_type: "VAEDecode",
    _meta: { title: "VAE Decode" },
  },
  "105:17": {
    inputs: { sampler_name: "euler" },
    class_type: "KSamplerSelect",
    _meta: { title: "KSamplerSelect" },
  },
  "105:9": {
    inputs: { scheduler: "beta", steps: 4, denoise: 1, model: ["105:121", 0] },
    class_type: "BasicScheduler",
    _meta: { title: "BasicScheduler" },
  },
  "105:14": {
    inputs: {
      noise: ["105:15", 0],
      guider: ["105:16", 0],
      sampler: ["105:17", 0],
      sigmas: ["105:9", 0],
      latent_image: ["105:104", 1],
    },
    class_type: "SamplerCustomAdvanced",
    _meta: { title: "SamplerCustomAdvanced" },
  },
  "105:16": {
    inputs: { model: ["105:121", 0], conditioning: ["105:104", 0] },
    class_type: "BasicGuider",
    _meta: { title: "Basic Guider" },
  },
  "105:6": {
    inputs: { unet_name: "10Eros_Max_h3_hybrid_beta5.safetensors", weight_dtype: "default" },
    class_type: "UNETLoader",
    _meta: { title: "Load Diffusion Model" },
  },
  "105:13": {
    inputs: { clip_name: "qwen3vl_32b_minimax_h3_bf16.safetensors", type: "minimax", device: "default" },
    class_type: "CLIPLoader",
    _meta: { title: "Load CLIP" },
  },
  "105:15": {
    inputs: { noise_seed: 0 },
    class_type: "RandomNoise",
    _meta: { title: "RandomNoise" },
  },
  "105:104": {
    inputs: {
      prompt: "__PROMPT__",
      width: 496,
      height: 496,
      length: ["105:107", 1],
      clip: ["105:13", 0],
      vae: ["105:11", 0],
      first_frame: ["114", 0],
    },
    class_type: "MiniMaxH3ImageToVideo",
    _meta: { title: "Image to Video" },
  },
  "105:107": {
    inputs: {
      expression: "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
      "values.a": ["105:111", 0],
    },
    class_type: "ComfyMathExpression",
    _meta: { title: "Math Expression" },
  },
  "105:111": {
    // Fixed 15-second duration — a fixed feature of this tab, not a user
    // control (see the task spec: "15秒音声付き").
    inputs: { value: 15 },
    class_type: "PrimitiveFloat",
    _meta: { title: "Float (duration)" },
  },
  "105:121": {
    inputs: {
      reuse_threshold: 0.3,
      start_percent: 0.2,
      end_percent: 0.9,
      verbose: false,
      model: ["105:124", 0],
    },
    class_type: "EasyCache",
    _meta: { title: "EasyCache" },
  },
  "105:124": {
    inputs: { sage_attention: "auto", allow_compile: true, model: ["105:125", 0] },
    class_type: "PathchSageAttentionKJ",
    _meta: { title: "Patch Sage Attention KJ" },
  },
  "105:125": {
    inputs: {
      lora_name: "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors",
      strength_model: 1,
      model: ["105:6", 0],
    },
    class_type: "LoraLoaderModelOnly",
    _meta: { title: "Load LoRA" },
  },
} as const;

// Generic, works for an arbitrary uploaded photo (no pose/reference video
// input on this tab, unlike Wan Animate 2) — describes a simple, pleasant
// camera move rather than inventing specific action the model has no basis
// for. The user's own prompt (if any) is appended as additional direction,
// same pattern as wanAnimateWorkflow.ts.
const DEFAULT_CINEMATIC_PROMPT =
  "Cinematic scene starting exactly from <Image 1>. Preserve the subject's appearance, clothing, and " +
  "the original background exactly as shown. A slow, smooth camera push-in with subtle natural motion " +
  "in the subject and environment (gentle breathing, hair and fabric moving softly, ambient light " +
  "shifting), soft cinematic color grading, shallow depth of field. Calm, atmospheric ambient sound " +
  "matching the scene, no dialogue.";

export type CinematicWorkflow = Record<
  string,
  { inputs: Record<string, unknown>; class_type: string; _meta?: { title: string } }
>;

export type BuildCinematicWorkflowParams = {
  mode: CinematicMode;
  prompt?: string | null;
  referenceImageName: string;
  /**
   * 動画の尺（秒）。省略時は既定の15秒（このタブの元々の固定仕様）。
   * 2026-09-13 実機確認: 15/30/60秒すべて成功（VRAMほぼフラット、155〜158GB）
   * — 尺自体は問題ではなかった。クラッシュの真因は解像度側のパッチ化端数
   * バグだった（floorTo16 のコメント参照）。ULL Cinematic Director が
   * 複数シーン合成後の合計尺として渡す。
   */
  durationS?: number;
  /** 生成物の内部プロンプトに"作り直す"余地を与えず、そのまま渡したい場合
   * （Director が既に合成済みの完全なプロンプトを渡すケース）。true なら
   * DEFAULT_CINEMATIC_PROMPT のベーステンプレートを重ねず prompt をそのまま使う。 */
  promptIsComplete?: boolean;
  /**
   * 実際にアップロードされた画像の生の幅・高さ（px）。渡すと
   * cinematicSafeDimensions で「ピクセル ≡ 16 (mod 32)」を満たす安全な
   * width/height を計算し、MiniMaxH3ImageToVideo へ literal 値として渡す
   * （2026-09-13 実障害の修正 — ファイル冒頭コメント参照）。省略時は
   * mode.baseEdge の正方形（496px 相当）にフォールバックする。
   */
  rawImageWidth?: number;
  rawImageHeight?: number;
  /**
   * ComfyUI 側 filename_prefix に埋め込むユニークキー。省略時は
   * WORKFLOW_TEMPLATE の固定値（"cinematic_video"）のまま。同一コンテナが
   * 複数ジョブを連続処理しても衝突しないよう、呼び出し側の generation_jobs
   * 行の id を渡す（CLAUDE.md §0 実測の通り実害は薄いが、SeedVR2 での
   * 実事故を踏まえた予防策として全ワークフロー共通で付与する。
   * 2026-09-17）。
   */
  jobId?: string;
  /**
   * ユーザー自身が LoRA Studio で学習した MiniMax H3 LoRA のファイル名
   * （拡張子込み、例: "yukipas_h3.safetensors"）。modal_lora_worker.py の
   * 「Directory contract」により、完了した LoRA は必ず
   * `loras/<lora_name>.safetensors`（Volume ルート直下のエイリアス）としても
   * 保存され、ComfyUI の LoraLoaderModelOnly からファイル名だけで解決できる。
   * 省略時はベースチェックポイントのみで生成する。
   */
  loraName?: string;
  /** ユーザーLoRAの強度（既定1.0）。 */
  loraStrength?: number;
};

export function buildCinematicWorkflow({
  mode,
  prompt,
  referenceImageName,
  durationS,
  promptIsComplete,
  rawImageWidth,
  rawImageHeight,
  jobId,
  loraName,
  loraStrength,
}: BuildCinematicWorkflowParams): CinematicWorkflow {
  const workflow = structuredClone(WORKFLOW_TEMPLATE) as unknown as CinematicWorkflow;

  if (jobId) {
    workflow["92"].inputs.filename_prefix = `cinematic_video_${jobId}`;
  }
  workflow["114"].inputs.image = referenceImageName;
  const { width: safeWidth, height: safeHeight } =
    rawImageWidth && rawImageHeight && rawImageWidth > 0 && rawImageHeight > 0
      ? cinematicSafeDimensions(rawImageWidth, rawImageHeight, cinematicMegapixels(mode))
      : cinematicSafeDimensions(1, 1, cinematicMegapixels(mode));
  workflow["105:104"].inputs.width = safeWidth;
  workflow["105:104"].inputs.height = safeHeight;
  workflow["105:9"].inputs.steps = mode.steps;
  if (durationS && durationS > 0) {
    workflow["105:111"].inputs.value = durationS;
  }

  const trimmedPrompt = prompt?.trim();
  workflow["105:104"].inputs.prompt = promptIsComplete
    ? trimmedPrompt || DEFAULT_CINEMATIC_PROMPT
    : trimmedPrompt
      ? `${DEFAULT_CINEMATIC_PROMPT}\nAdditional direction: ${trimmedPrompt}`
      : DEFAULT_CINEMATIC_PROMPT;

  // A fresh seed per request — an identical workflow_json (same seed +
  // same inputs) hits ComfyUI's node-level execution cache and returns a
  // previously-generated result instantly instead of actually sampling
  // (confirmed while benchmarking this exact graph).
  workflow["105:15"].inputs.noise_seed = Math.floor(Math.random() * 2 ** 32);

  // ユーザー選択LoRA（2026-09-18導入）— UNETLoader(105:6)の直後、ターボLoRA/
  // VDN-H3より手前に差し込む（コミュニティのComfyUIワークフロー例が使っていた
  // LoraLoaderModelOnly → ApplyVDNH3 の重ね順を踏襲）。以降のノードが
  // UNETLoaderの生出力を直接参照していた箇所は全てこのLoRA適用後の出力
  // (baseModelRef) を見るように差し替える。
  const trimmedLoraName = loraName?.trim();
  const baseModelRef: [string, number] = trimmedLoraName ? ["105:126", 0] : ["105:6", 0];
  if (trimmedLoraName) {
    workflow["105:126"] = {
      inputs: {
        lora_name: trimmedLoraName,
        strength_model: typeof loraStrength === "number" && loraStrength > 0 ? loraStrength : 1,
        model: ["105:6", 0],
      },
      class_type: "LoraLoaderModelOnly",
      _meta: { title: "Load LoRA (User)" },
    };
  }

  // The 4-step turbo LoRA only makes sense paired with a low step count —
  // Cinema Master's full 20-step run skips it entirely (feeds
  // PathchSageAttentionKJ straight from UNETLoader) rather than running a
  // LoRA distilled for 4 steps through 20 of them.
  if (mode.useTurboLora) {
    workflow["105:125"].inputs.model = baseModelRef;
    workflow["105:124"].inputs.model = ["105:125", 0];
  } else {
    workflow["105:124"].inputs.model = baseModelRef;
    delete (workflow as Record<string, unknown>)["105:125"];
  }

  // VDN-H3 (github.com/Saganaki22/ComfyUI-VDN-H3 + OpenVDN/vdn-minimax-h3,
  // Apache-2.0、2026-09-13/14導入) — UNETLoader と PathchSageAttentionKJ の
  // 間に差し込む。実機検証済みの設定: lora_mode="bypass"（非破壊・低VRAM
  // オーバーヘッド、BF16フル精度のまま適用可能なことをVDN-H3実装コード
  // 読解で確認済み）。allow_compile は VDN-H3 併用時に明確な悪化が実測され
  // たため常に false 固定（torch.compileのブロック単位再コンパイル地獄、
  // [[vdn-h3-speedup-integration]] 参照）。
  if (mode.useVdn) {
    workflow["105:130"] = {
      inputs: {
        model: baseModelRef,
        vdn_checkpoint: mode.vdnCheckpoint ?? "stage-b-step-2000",
        apply_turbo_adapter: Boolean(mode.vdnTurbo),
        strength: 1.0,
        lora_mode: "bypass",
        branch_weights: "auto",
        retain_buffers: "auto",
        attention_backend: "grouped",
        verbose: false,
      },
      class_type: "ApplyVDNH3",
      _meta: { title: "Apply VDN-H3 (MiniMax-H3 Hybrid Attention)" },
    };
    workflow["105:124"].inputs.model = ["105:130", 0];
    workflow["105:124"].inputs.allow_compile = false;
  }

  return workflow;
}
