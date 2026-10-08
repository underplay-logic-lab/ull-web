import "server-only";
import type { CinematicMode, DirectorResolution } from "@/lib/cinematicPricing";
import { cinematicMegapixelsForDuration, cinematicSafeDimensions, photoOutputDimensions } from "@/lib/cinematicPricing";
import { clampPhotoCount, type DirectorRefRole, type DirectorRefVideoRole } from "@/lib/directorPricing";

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
    inputs: { scheduler: "beta", steps: 4, denoise: 1, model: ["105:124", 0] },
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
    inputs: { model: ["105:124", 0], conditioning: ["105:104", 0] },
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
  // EasyCache（105:121）は外した（2026-10-08 ホスト判断）。20 秒・Quality・同じシードの あり／なし 比較で、ありは手の動きの破綻が
  // 目立った（D:/ComfyUI-ull/results/prod/easycache/）。時間はありの方が 34% 短いが、品質を優先し Fast も含め全モードで使わない
  // （速さは step 数の違いだけにする）。サンプラーとガイダーは Sage のパッチ（105:124）から直接受ける。
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
  /** 解像度の段（2026-10-08・540p／768p）。省略時は 768p（従来の短い動画と同じ約 1MP）。 */
  resolution?: DirectorResolution;
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
  /**
   * 動画のシード（2026-10-01〜。route が決めて inputs.seed に残し、「作り直す」で引き継ぐ）。
   * 省略時はランダム。同じシード＋同じ入力だと ComfyUI のキャッシュで前の結果がそのまま返る（下のコメント）。
   */
  seed?: number;
  /**
   * 持ち込み音声（歌・セリフ）の ComfyUI input 名（2026-10-05）。渡すと音声をそのまま固定して、口をそれに合わせる。
   * 組み方は D:\ComfyUI-ull\prod_hinata_mv_68s_v3.json（本番 B300 で 68 秒を完走）と同じ:
   *   ① 音声 VAE で潜在にし、ノイズマスク 0（＝作り直さない）で映像の潜在の音声部分を差し替える（LTXVConcatAVLatent。
   *      長さが違えば本体が切り詰め／末尾を生成で埋める）
   *   ② MiniMaxH3AddGuide で同じ音声を先頭に固定した条件にする（①だけより口が合う）
   * MiniMaxH3AddGuide だけだと音声は「参考」扱いで作り直され、冒頭の伴奏中に口が動いた。
   * 書き出す音声は VAE を通したものではなく元のファイル（音声 VAE を通すと波形が少し変わる）。
   */
  audioName?: string;
  /** true: 画像を最初のフレームではなく顔写真として参照する（MiniMaxH3ReferenceToVideo・本体は 10Eros（REF2VA_UNET））。 */
  referenceMode?: boolean;
  /**
   * 参照モードで足す写真の ComfyUI input 名（最大 8 枚、2026-10-05）。1 枚目（referenceImageName）と合わせて最大 9 枚。
   * 同じ人物の角度・表情違いを入れると、LoRA なしで顔・細部が保たれ、口もよく動く（ひなた・ゆきのぱすてるで確認、docs/STATUS.md）。
   * ノードの欄は ref_image_0〜ref_image_8（0 始まり。ref_image_9 は TypeError になる）。
   */
  extraReferenceImageNames?: string[];
  /** 足した写真それぞれの使い方（extraReferenceImageNames と同じ順、2026-10-06）。省略・不明は「同じ人物」。 */
  extraReferenceRoles?: DirectorRefRole[];
  /** 参照動画（動き／カメラの手本、2026-10-06）の ComfyUI input 名と使い方。欄は ref_videos.ref_video_0（<Video 1>）。 */
  refVideoName?: string;
  refVideoRole?: DirectorRefVideoRole;
  /** 声の手本の ComfyUI input 名（2026-10-06）。欄は ref_audios.ref_audio_0（<Audio 1>）。持ち込み音声とは併用しない。 */
  refVoiceName?: string;
  /** 出力の縦横比を決める寸法（参照モードで縦横を選んだとき）。省略時は rawImageWidth/Height。 */
  aspectWidth?: number;
  aspectHeight?: number;
};

/**
 * 参照モードの本体（2026-10-06〜 10Eros に一本化）。最初のフレームと同じ重みなので、モードを切り替えても読み込み直しが無い。
 * 本番 B300 で公式 ref2va bf16 と同じワークフロー・シードで比べ（ひなた 9 枚参照・歌固定 20 秒、
 * D:\ComfyUI-ull\results\prod\a_test\out_multiref_A{,_10eros}.mp4）、口の動き 2.99 → 3.10・顔は見分けがつかない程度。
 * 公式 ref2va（minimax_h3_ref2va_pruned_bf16.safetensors）は Volume に残してある（戻すならこの値を変えるだけ）。
 */
const REF2VA_UNET = "10Eros_Max_h3_hybrid_beta5.safetensors";

/** 参照写真の最大枚数（MiniMaxH3ReferenceToVideo の ref_images の上限）。 */
export const MAX_REFERENCE_IMAGES = 9;

/**
 * 参照モードのプロンプト（2026-10-05、使い方の振り分けは 2026-10-06）。画像は <Picture N>（最初のフレームの <Image 1> とは別の書き方）、
 * 動画は <Video 1>、声は <Audio 1>。書き方は B300 で確かめたもの（D:\ComfyUI-ull\tools\wf_roles.ts）:
 * 人物の写真が複数なら「同じ人物が <Picture 2>… にも」と添え、持ち物・場所・画風・手本は 1 文ずつ足す。
 * 台本（Gemini／Qwen）がその番号に既に触れていれば足さない（二重に書かない）。
 */
function toReferencePrompt(
  prompt: string,
  roles: DirectorRefRole[] = [],
  refVideoRole?: DirectorRefVideoRole,
  hasVoice = false,
): string {
  const p = prompt.replace(/<Image 1>/g, "<Picture 1>");
  const tag = (i: number) => `<Picture ${i + 2}>`;
  const listTags = (tags: string[]) => (tags.length > 1 ? `${tags.slice(0, -1).join(", ")} and ${tags[tags.length - 1]}` : tags[0]);
  const people = roles.flatMap((r, i) => (r === "person" ? [tag(i)] : []));
  const also = people.length ? ` (the same person is also shown in ${listTags(people)})` : "";
  const notes: string[] = [];
  roles.forEach((r, i) => {
    const t = tag(i);
    if (r === "person" || p.includes(t)) return;
    if (r === "item") notes.push(`The object from ${t} appears exactly as shown there (same shape, colors and details).`);
    if (r === "place") notes.push(`The setting is the place shown in ${t} (same scenery, layout and colors).`);
    if (r === "style") notes.push(`The whole video is drawn in exactly the same art style, colors and rendering as ${t}.`);
  });
  if (refVideoRole && !p.includes("<Video 1>")) {
    notes.push(
      refVideoRole === "motion"
        ? "The character's body movements copy the movements of the person in <Video 1> — the gestures and the rhythm — but the face, hair, clothes and the background stay those of the references, never the person or the room from <Video 1>."
        : "The camera movement copies the camera movement of <Video 1> (its path, speed and framing changes); nothing else from <Video 1> appears — not its people, objects or background.",
    );
  }
  if (hasVoice && !p.includes("<Audio 1>")) {
    notes.push("Whenever the character speaks or sings, it is in exactly the voice of <Audio 1>.");
  }
  const extra = notes.length ? ` ${notes.join(" ")}` : "";
  if (!p.includes("<Picture 1>")) {
    return `The person from <Picture 1>${also} (same face, hairstyle and features) appears throughout the video.${extra} ${p}`;
  }
  const withAlso = also && !people.every((t) => p.includes(t)) ? p.replace("<Picture 1>", `<Picture 1>${also}`) : p;
  return extra ? `${extra.trim()} ${withAlso}` : withAlso;
}

export function buildCinematicWorkflow({
  mode,
  prompt,
  referenceImageName,
  durationS,
  resolution,
  promptIsComplete,
  rawImageWidth,
  rawImageHeight,
  jobId,
  loraName,
  loraStrength,
  seed,
  audioName,
  referenceMode,
  extraReferenceImageNames,
  extraReferenceRoles,
  refVideoName,
  refVideoRole,
  refVoiceName,
  aspectWidth,
  aspectHeight,
}: BuildCinematicWorkflowParams): CinematicWorkflow {
  const workflow = structuredClone(WORKFLOW_TEMPLATE) as unknown as CinematicWorkflow;

  if (jobId) {
    workflow["92"].inputs.filename_prefix = `cinematic_video_${jobId}`;
  }
  workflow["114"].inputs.image = referenceImageName;
  const dimW = aspectWidth && aspectHeight ? aspectWidth : rawImageWidth;
  const dimH = aspectWidth && aspectHeight ? aspectHeight : rawImageHeight;
  const mp = cinematicMegapixelsForDuration(mode, durationS, resolution);
  const { width: safeWidth, height: safeHeight } =
    dimW && dimH && dimW > 0 && dimH > 0 ? cinematicSafeDimensions(dimW, dimH, mp) : cinematicSafeDimensions(1, 1, mp);
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
  workflow["105:15"].inputs.noise_seed = seed ?? Math.floor(Math.random() * 2 ** 32);

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

  if (referenceMode) {
    workflow["105:6"].inputs.unet_name = REF2VA_UNET;
    const i2v = workflow["105:104"].inputs;
    const extras = (extraReferenceImageNames ?? []).filter(Boolean).slice(0, MAX_REFERENCE_IMAGES - 1);
    const roles = extras.map((_, i) => extraReferenceRoles?.[i] ?? "person");
    const refInputs: Record<string, unknown> = { "ref_images.ref_image_0": ["114", 0] };
    extras.forEach((name, i) => {
      const id = `${301 + i}`;
      workflow[id] = { inputs: { image: name }, class_type: "LoadImage", _meta: { title: `Reference ${i + 2}` } };
      refInputs[`ref_images.ref_image_${i + 1}`] = [id, 0];
    });
    // 参照動画は映像だけを渡す（ref_video_audios は繋がない＝手本の音は使わない）。24fps 前提のノードなので、
    // 30fps の動画は少しゆっくりした手本として読まれる（動きの手本としては実害が小さいので変換はしない）。
    const videoRole = refVideoName ? refVideoRole ?? "motion" : undefined;
    if (refVideoName) {
      workflow["320"] = { inputs: { file: refVideoName }, class_type: "LoadVideo", _meta: { title: "Reference Video" } };
      workflow["321"] = { inputs: { video: ["320", 0] }, class_type: "GetVideoComponents", _meta: { title: "Reference Video Frames" } };
      refInputs["ref_videos.ref_video_0"] = ["321", 0];
    }
    // 持ち込み音声（歌・セリフ固定）があるときは声の手本を使わない（声はその音声で決まっている）。
    const voiceName = audioName?.trim() ? undefined : refVoiceName;
    if (voiceName) {
      workflow["330"] = { inputs: { audio: voiceName }, class_type: "LoadAudio", _meta: { title: "Reference Voice" } };
      refInputs["ref_audios.ref_audio_0"] = ["330", 0];
    }
    workflow["105:104"] = {
      inputs: {
        clip: i2v.clip,
        vae: i2v.vae,
        audio_vae: ["105:24", 0],
        prompt: toReferencePrompt(String(i2v.prompt), roles, videoRole, Boolean(voiceName)),
        width: i2v.width,
        height: i2v.height,
        length: i2v.length,
        ref_image_size: "match",
        ...refInputs,
      },
      class_type: "MiniMaxH3ReferenceToVideo",
      _meta: { title: "Reference to Video" },
    };
  }

  const trimmedAudioName = audioName?.trim();
  if (trimmedAudioName) {
    workflow["200"] = { inputs: { audio: trimmedAudioName }, class_type: "LoadAudio", _meta: { title: "Load Audio" } };
    workflow["201"] = {
      inputs: {
        positive: ["105:104", 0],
        audio_vae: ["105:24", 0],
        latent: ["105:104", 1],
        audio: ["200", 0],
        frame_idx: 0,
      },
      class_type: "MiniMaxH3AddGuide",
      _meta: { title: "Add Guide (audio)" },
    };
    workflow["210"] = {
      inputs: { audio: ["200", 0], vae: ["105:24", 0] },
      class_type: "VAEEncodeAudio",
      _meta: { title: "VAE Encode Audio" },
    };
    workflow["211"] = {
      inputs: { value: 0.0, width: 64, height: 64 },
      class_type: "SolidMask",
      _meta: { title: "Mask 0 (keep audio)" },
    };
    workflow["212"] = {
      inputs: { samples: ["210", 0], mask: ["211", 0] },
      class_type: "SetLatentNoiseMask",
      _meta: { title: "Set Latent Noise Mask" },
    };
    workflow["213"] = {
      inputs: { video_latent: ["105:104", 1], audio_latent: ["212", 0] },
      class_type: "LTXVConcatAVLatent",
      _meta: { title: "Concat AV Latent" },
    };
    workflow["105:16"].inputs.conditioning = ["201", 0];
    workflow["105:14"].inputs.latent_image = ["213", 0];
    workflow["91"].inputs.audio = ["200", 0];
  }

  return workflow;
}


/**
 * Photo Director（2026-10-06）: 参照モードの Director の条件づけ（参照 9 枚まで）で、本当に 1 コマだけの静止画を作る。
 * 2026-10-06 夜〜 Fizgig H3 Still（ワーカーの image に同梱・MIT）: サンプラーの潜在を FizgigH3StillLatent（1 コマ）にし、
 * FizgigH3StillDecode で戻す（1 コマを 5 コマ分に複製して戻し、落ち着いた 3 コマ目を取る＝標準の VAE Decode で出る縞が出ない）。
 * それまでは長さ 5 フレームの動画を作って 1 コマ目を抜いていた（下の length 5 はその名残で、条件づけの長さとしてだけ使う）。
 * 本番 B300 で確かめた組み方（D:\ComfyUI-ull\results\prod\a_test\wf_still_bf16_*.json）: length 5・ref_image_size "max"
 * （参照を 2048px 短辺で読む＝顔が最も写真に近い）・高速モード（VDN 8 step）。
 * 条件づけ（105:104）は 1 つを共有し、シードだけ違うサンプラーを枚数ぶん並べる（参照の読み込みを 1 回で済ませる）。
 * 出力は枝ごとの SaveImage。ワーカーは image_outputs=true で全部を集めて R2 へ上げる。
 */
/** Photo Director を動かす GPU（2026-10-06 実測で決定。ワーカーの custom_workflow_async が許す値だけ）。 */
export const PHOTO_GPU = "H200";

export function buildPhotoWorkflow(
  params: Omit<BuildCinematicWorkflowParams, "referenceMode" | "durationS" | "audioName" | "refVideoName" | "refVideoRole">,
  count: number,
): CinematicWorkflow {
  // 参照の読み込み（参照 9 枚の符号化）は 1 回で済み、枚数ぶんはサンプリングだけ増える。ノード id は 600〜647 を使う。
  const n = clampPhotoCount(count);
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
  const workflow = buildCinematicWorkflow({ ...params, seed, referenceMode: true, durationS: 1 });
  const cond = workflow["105:104"].inputs;
  cond.length = 5;
  cond.ref_image_size = "max";
  // 出力は動画の解像度（約 1MP）ではなく写真用の 2.5MP（PHOTO_MEGAPIXELS）。縦横の比は動画と同じ決め方。
  const shapeW = params.aspectWidth && params.aspectHeight ? params.aspectWidth : params.rawImageWidth;
  const shapeH = params.aspectWidth && params.aspectHeight ? params.aspectHeight : params.rawImageHeight;
  const photoDims = shapeW && shapeH && shapeW > 0 && shapeH > 0 ? photoOutputDimensions(shapeW, shapeH) : photoOutputDimensions(1, 1);
  cond.width = photoDims.width;
  cond.height = photoDims.height;
  // 「画風」の写真で足す一文は動画向けの言い回し（toReferencePrompt）。写真では image に直す。
  cond.prompt = String(cond.prompt).replace("The whole video is drawn", "The whole image is drawn");
  // 写真は H200 で動かす（PHOTO_GPU）。今の image の SageAttention は Blackwell 向けだけで、H200 では
  // "SM90 kernel is not available" で落ちる（2026-10-06 実際に落ちた）→ PyTorch 標準の計算にする。
  // それでも B300（SageAttention あり）より起動込みで速かった（185s 対 327s、docs/gpu-benchmarks.md）。
  workflow["105:124"].inputs.sage_attention = "disabled";
  // 動画・音声の書き出しと長さの計算は使わない。
  for (const id of ["91", "92", "105:23", "105:107", "105:111", "105:15", "105:14", "105:10"]) {
    delete (workflow as Record<string, unknown>)[id];
  }
  const prefix = params.jobId ? `photo_${params.jobId}` : "photo";
  // 1 コマの潜在（条件づけと同じ幅・高さ）。シードごとのサンプラーで共有する（中身はゼロなので共有して問題ない）。
  workflow["650"] = {
    inputs: { width: cond.width, height: cond.height, batch_size: 1 },
    class_type: "FizgigH3StillLatent",
    _meta: { title: "Still Latent (1 frame)" },
  };
  for (let i = 0; i < n; i++) {
    workflow[`${600 + i}`] = {
      inputs: { noise_seed: (seed + i) % 2 ** 32 },
      class_type: "RandomNoise",
      _meta: { title: `Noise ${i + 1}` },
    };
    workflow[`${610 + i}`] = {
      inputs: {
        noise: [`${600 + i}`, 0],
        guider: ["105:16", 0],
        sampler: ["105:17", 0],
        sigmas: ["105:9", 0],
        latent_image: ["650", 0],
      },
      class_type: "SamplerCustomAdvanced",
      _meta: { title: `Sampler ${i + 1}` },
    };
    workflow[`${620 + i}`] = {
      inputs: { samples: [`${610 + i}`, 0], vae: ["105:11", 0] },
      class_type: "FizgigH3StillDecode",
      _meta: { title: `Still Decode ${i + 1}` },
    };
    workflow[`${640 + i}`] = {
      inputs: { images: [`${620 + i}`, 0], filename_prefix: `${prefix}_${i + 1}` },
      class_type: "SaveImage",
      _meta: { title: `Save Photo ${i + 1}` },
    };
  }
  return workflow;
}
