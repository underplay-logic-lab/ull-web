import "server-only";
import type { CinematicMode } from "@/lib/cinematicPricing";
import { cinematicMegapixels } from "@/lib/cinematicPricing";

// The "Cinematic Video" tab's ComfyUI API-format graph — MiniMax H3 (BF16,
// image-to-audio/video) running on the Blackwell/B300 Modal deployment (see
// modal_wan_animate_blackwell.py's WanAnimateBlackwell.custom_workflow).
// Validated end-to-end against that deployment before being ported here —
// node ids/wiring mirror the working payload used to measure ~26.8s warm /
// ~4.75s per step at steps=4. Deliberately does NOT expose "MiniMax H3"
// anywhere client-facing (filename_prefix included) — see the branding
// decision behind this tab's "Cinematic Video" name.
//
// Two things ImageScaleToTotalPixels (node "119") does that make it worth
// keeping in the graph even though the client already crops/resizes the
// upload itself: it re-derives the *actual* final width/height from the
// real uploaded image (node "120" GetImageSize reads its output, which
// MiniMaxH3ImageToVideo's width/height wire from) rather than trusting a
// client-declared number, and it snaps those dimensions to a multiple of
// `resolution_steps` (set to 16 here) as a hard backend-side guarantee —
// the client's own crop/Canvas step already targets a 16-multiple, but this
// is what actually enforces it no matter what arrives.
const WORKFLOW_TEMPLATE = {
  "92": {
    inputs: {
      filename_prefix: "cinematic_video",
      format: "auto",
      codec: "auto",
      video: ["105:91", 0],
    },
    class_type: "SaveVideo",
    _meta: { title: "Save Video" },
  },
  "114": {
    inputs: { image: "__REFERENCE_IMAGE__" },
    class_type: "LoadImage",
    _meta: { title: "Load Image" },
  },
  "119": {
    inputs: {
      upscale_method: "bicubic",
      megapixels: 0.262144,
      resolution_steps: 16,
      image: ["114", 0],
    },
    class_type: "ImageScaleToTotalPixels",
    _meta: { title: "Scale Image to Total Pixels" },
  },
  "120": {
    inputs: { image: ["119", 0] },
    class_type: "GetImageSize",
    _meta: { title: "Get Image Size" },
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
    inputs: { unet_name: "minimax_h3_fl2va_bf16.safetensors", weight_dtype: "default" },
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
  "105:91": {
    inputs: { fps: 24, bit_depth: 8, images: ["105:10", 0], audio: ["105:23", 0] },
    class_type: "CreateVideo",
    _meta: { title: "Create Video" },
  },
  "105:104": {
    inputs: {
      prompt: "__PROMPT__",
      width: ["120", 0],
      height: ["120", 1],
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
};

export function buildCinematicWorkflow({
  mode,
  prompt,
  referenceImageName,
}: BuildCinematicWorkflowParams): CinematicWorkflow {
  const workflow = structuredClone(WORKFLOW_TEMPLATE) as unknown as CinematicWorkflow;

  workflow["114"].inputs.image = referenceImageName;
  workflow["119"].inputs.megapixels = cinematicMegapixels(mode);
  workflow["105:9"].inputs.steps = mode.steps;

  const trimmedPrompt = prompt?.trim();
  workflow["105:104"].inputs.prompt = trimmedPrompt
    ? `${DEFAULT_CINEMATIC_PROMPT}\nAdditional direction: ${trimmedPrompt}`
    : DEFAULT_CINEMATIC_PROMPT;

  // A fresh seed per request — an identical workflow_json (same seed +
  // same inputs) hits ComfyUI's node-level execution cache and returns a
  // previously-generated result instantly instead of actually sampling
  // (confirmed while benchmarking this exact graph).
  workflow["105:15"].inputs.noise_seed = Math.floor(Math.random() * 2 ** 32);

  // The 4-step turbo LoRA only makes sense paired with a low step count —
  // Cinema Master's full 20-step run skips it entirely (feeds
  // PathchSageAttentionKJ straight from UNETLoader) rather than running a
  // LoRA distilled for 4 steps through 20 of them.
  if (mode.useTurboLora) {
    workflow["105:124"].inputs.model = ["105:125", 0];
  } else {
    workflow["105:124"].inputs.model = ["105:6", 0];
    delete (workflow as Record<string, unknown>)["105:125"];
  }

  return workflow;
}
