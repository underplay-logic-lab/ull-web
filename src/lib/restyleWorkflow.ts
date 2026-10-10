import "server-only";
import { RESTYLE_KEEPS, RESTYLE_STYLES, type RestyleKeepId, type RestyleStyleId } from "@/lib/restylePricing";

/**
 * 画風を変える（構図そのまま・2026-10-10）の ComfyUI ワークフロー。modal_wan_animate_blackwell.py の custom_workflow_async
 * （image_outputs・RTX PRO 6000）で動かす。手元の検証は D:\ComfyUI-ull\roomref\restyle2512.py（ホストの Illustrious の流れと同じ考え方）:
 *   1. 元画像を言語化する AI（Qwen3-VL 8B）に「この場面を〈画風〉で描き直す指示文を書け」と頼む（画風まで書かせないと写真調に戻る）
 *   2. 元画像の線（ComfyUI 本体の Canny）を Fun ControlNet Union で弱めにかけ、生成の途中で切る（形をなんとなく保って別物にする）
 *   3. Qwen-Image-2512 で描く（50 step・cfg 4 が公式の既定。ここは 40 step）
 * モデル（すべて Apache-2.0・2026-10-10 確認、docs/model-licenses.md）: Qwen-Image-2512 bf16・Qwen2.5-VL 7B・Qwen Image VAE（Comfy-Org/Qwen-Image_ComfyUI）、
 * Qwen3-VL 8B bf16（Comfy-Org/Qwen3-VL）、Qwen-Image-2512-Fun-Controlnet-Union-2602（alibaba-pai）。Qwen-Image 2.1 は非商用なので使わない。
 * 出力は枝ごとの SaveImage（ワーカーが全部集めて R2 へ）。Canny の確認画像は保存しない（集められてしまう）。
 */
export const RESTYLE_STEPS = 40;

export function buildRestyleWorkflow(args: {
  imageName: string;
  width: number;
  height: number;
  style: RestyleStyleId;
  /** style が free のときの画風の文（利用者の入力）。 */
  freeStyle?: string;
  keep: RestyleKeepId;
  count: number;
  seed: number;
  prefix: string;
}): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const styleText =
    args.style === "free" ? (args.freeStyle ?? "").trim() : (RESTYLE_STYLES.find((s) => s.id === args.style)?.prompt ?? "");
  const keep = RESTYLE_KEEPS.find((k) => k.id === args.keep) ?? RESTYLE_KEEPS[1];
  const ask =
    `Write a detailed prompt for an image generator that redraws the scene in this image as ${styleText}. One paragraph of English. ` +
    "Start with the art style. Then describe the layout from left to right and front to back: every person with their appearance, clothing and pose, " +
    "every piece of furniture and object with its shape and color, the background, and the lighting. " +
    "Never use the words photo, photograph, realistic or camera.";
  const wf: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2512_bf16.safetensors", weight_dtype: "default" } },
    "2": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.1 } },
    "3": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b.safetensors", type: "qwen_image", device: "default" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_bf16.safetensors", type: "qwen_image", device: "default" } },
    "20": { class_type: "LoadImage", inputs: { image: args.imageName } },
    "21": {
      class_type: "ImageScale",
      inputs: { image: ["20", 0], upscale_method: "lanczos", width: args.width, height: args.height, crop: "center" },
    },
    "22": { class_type: "Canny", inputs: { image: ["21", 0], low_threshold: 0.3, high_threshold: 0.4 } },
    "40": { class_type: "TextGenerate", inputs: { clip: ["5", 0], prompt: ask, image: ["21", 0], max_length: 400, sampling_mode: "off" } },
    "41": {
      class_type: "StringConcatenate",
      inputs: { string_a: ["40", 0], string_b: `Redrawn as ${styleText}, rich detail.`, delimiter: " " },
    },
    "42": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: ["41", 0] } },
    "43": { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: "" } },
    "6": { class_type: "ControlNetLoader", inputs: { control_net_name: "Qwen-Image-2512-Fun-Controlnet-Union-2602.safetensors" } },
    "7": {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        positive: ["42", 0],
        negative: ["43", 0],
        control_net: ["6", 0],
        image: ["22", 0],
        strength: keep.strength,
        start_percent: 0,
        end_percent: keep.end,
        vae: ["4", 0],
      },
    },
    "8": { class_type: "EmptySD3LatentImage", inputs: { width: args.width, height: args.height, batch_size: 1 } },
  };
  for (let i = 0; i < args.count; i++) {
    wf[`${600 + i}`] = {
      class_type: "KSampler",
      inputs: {
        model: ["2", 0],
        positive: ["7", 0],
        negative: ["7", 1],
        latent_image: ["8", 0],
        seed: (args.seed + i) % 2 ** 32,
        steps: RESTYLE_STEPS,
        cfg: 4,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
      },
    };
    wf[`${620 + i}`] = { class_type: "VAEDecode", inputs: { samples: [`${600 + i}`, 0], vae: ["4", 0] } };
    wf[`${640 + i}`] = { class_type: "SaveImage", inputs: { images: [`${620 + i}`, 0], filename_prefix: `${args.prefix}_${i + 1}` } };
  }
  return wf;
}
