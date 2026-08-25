import "server-only";

// The Wan Animate 2 ComfyUI API-format graph, validated end-to-end against
// the production Modal deployment (ComfyUI v0.33.3). Node ids/wiring mirror
// the ComfyUI-Wizard export in scripts/test-wan-animate.ts's workflow JSON;
// SaveVideo's format/codec here are already the v0.33.3-compatible values
// (that file targets an older RunPod ComfyUI and is left untouched).
const WORKFLOW_TEMPLATE = {
  "189": {
    inputs: { image: "__REFERENCE_IMAGE__" },
    class_type: "LoadImage",
    _meta: { title: "Load Image (Reference Image)" },
  },
  "240": {
    inputs: { file: "__POSE_VIDEO__", "video-preview": "" },
    class_type: "LoadVideo",
    _meta: { title: "Load Video (Pose Video)" },
  },
  "245": {
    inputs: { images: ["261:299", 0], fps: 16 },
    class_type: "CreateVideo",
    _meta: { title: "Create Video" },
  },
  "246": {
    inputs: { video: ["245", 0], filename_prefix: "wan_animate2", format: "mp4", codec: "h264" },
    class_type: "SaveVideo",
    _meta: { title: "Save Video" },
  },
  "288": {
    inputs: { video: ["240", 0] },
    class_type: "GetVideoComponents",
    _meta: { title: "Get Video Components" },
  },
  "289": {
    inputs: { "images.image0": ["261:299", 0] },
    class_type: "BatchImagesNode",
    _meta: { title: "Batch Images" },
  },
  "261:239": {
    inputs: { unet_name: "wan_animate_2_int8_convrot.safetensors", weight_dtype: "default" },
    class_type: "UNETLoader",
    _meta: { title: "Load Diffusion Model" },
  },
  "261:11": {
    inputs: {
      lora_name: "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
      strength_model: 1,
      model: ["261:239", 0],
    },
    class_type: "LoraLoaderModelOnly",
    _meta: { title: "Load LoRA" },
  },
  "261:9": {
    inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" },
    class_type: "CLIPLoader",
    _meta: { title: "Load CLIP" },
  },
  "261:4": {
    inputs: {
      text: "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走",
      clip: ["261:9", 0],
    },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Negative Prompt)" },
  },
  "261:3": {
    inputs: { text: "__CHARACTER_PROMPT__", clip: ["261:9", 0] },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Positive Prompt)" },
  },
  "261:75": {
    inputs: { clip_name: "clip_vision_h.safetensors" },
    class_type: "CLIPVisionLoader",
    _meta: { title: "Load CLIP Vision" },
  },
  "261:7": {
    inputs: { vae_name: "Wan2_1_VAE_bf16.safetensors" },
    class_type: "VAELoader",
    _meta: { title: "Load VAE" },
  },
  "261:222": {
    inputs: { text: "__MOTION_PROMPT__", clip: ["261:9", 0] },
    class_type: "CLIPTextEncode",
    _meta: { title: "CLIP Text Encode (Prompt)" },
  },
  "261:257": {
    inputs: {
      context_length: 21,
      context_overlap: 8,
      context_schedule: "standard_static",
      context_stride: 1,
      closed_loop: false,
      fuse_method: "pyramid",
      dim: 2,
      freenoise: true,
      cond_retain_index_list: "0",
      split_conds_to_windows: false,
      latent_retain_index_list: "",
      causal_window_fix: true,
      model: ["261:11", 0],
    },
    class_type: "ContextWindowsManual",
    _meta: { title: "Context Windows (Manual)" },
  },
  "261:247": {
    inputs: {
      width: ["261:256", 0],
      height: ["261:256", 1],
      length: 81,
      batch_size: 1,
      video_frame_offset: 0,
      pose_strength: 1,
      pose_start_percent: 0,
      pose_end_percent: 1,
      reference_image_strength: 1,
      positive: ["261:3", 0],
      negative: ["261:4", 0],
      vae: ["261:7", 0],
      reference_image: ["261:244", 0],
      pose_video: ["261:243", 0],
      clip_vision_output: ["261:76", 0],
      positive_pose: ["261:222", 0],
      clip_vision_output_pose: ["261:220", 0],
    },
    class_type: "WanAnimate2ToVideo",
    _meta: { title: "WanAnimate2ToVideo" },
  },
  "261:258": {
    inputs: { switch: false, on_false: ["261:11", 0], on_true: ["261:257", 0] },
    class_type: "ComfySwitchNode",
    _meta: { title: "If/Else Switch" },
  },
  "261:76": {
    inputs: { crop: "none", clip_vision: ["261:75", 0], image: ["261:244", 0] },
    class_type: "CLIPVisionEncode",
    _meta: { title: "CLIP Vision Encode" },
  },
  "261:244": {
    inputs: {
      resize_type: "scale dimensions",
      "resize_type.width": ["261:256", 0],
      "resize_type.height": ["261:256", 1],
      "resize_type.crop": "center",
      scale_method: "area",
      input: ["189", 0],
    },
    class_type: "ResizeImageMaskNode",
    _meta: { title: "Resize Image/Mask" },
  },
  "261:18": {
    inputs: { scheduler: "simple", steps: 6, denoise: 1, model: ["261:258", 0] },
    class_type: "BasicScheduler",
    _meta: { title: "BasicScheduler" },
  },
  "261:95": {
    inputs: { shift: 5, model: ["261:258", 0] },
    class_type: "ModelSamplingSD3",
    _meta: { title: "ModelSamplingSD3" },
  },
  "261:27": {
    inputs: { sampler_name: "lcm" },
    class_type: "KSamplerSelect",
    _meta: { title: "KSamplerSelect" },
  },
  "261:241": {
    inputs: { video: ["240", 0] },
    class_type: "GetVideoComponents",
    _meta: { title: "Get Video Components" },
  },
  "261:256": {
    inputs: { image: ["261:243", 0] },
    class_type: "GetImageSize",
    _meta: { title: "Get Image Size" },
  },
  "261:19": {
    inputs: {
      add_noise: true,
      noise_seed: 1021794000768666,
      cfg: 1,
      model: ["261:95", 0],
      positive: ["261:247", 0],
      negative: ["261:247", 1],
      sampler: ["261:27", 0],
      sigmas: ["261:18", 0],
      latent_image: ["261:247", 2],
    },
    class_type: "SamplerCustom",
    _meta: { title: "SamplerCustom" },
  },
  "261:220": {
    inputs: { crop: "none", clip_vision: ["261:75", 0], image: ["261:236", 0] },
    class_type: "CLIPVisionEncode",
    _meta: { title: "CLIP Vision Encode" },
  },
  "261:236": {
    inputs: { batch_index: 0, length: 1, image: ["261:243", 0] },
    class_type: "ImageFromBatch",
    _meta: { title: "Get Image from Batch" },
  },
  "261:243": {
    inputs: {
      resize_type: "scale dimensions",
      "resize_type.width": 482,
      "resize_type.height": 854,
      "resize_type.crop": "center",
      scale_method: "area",
      input: ["261:241", 0],
    },
    class_type: "ResizeImageMaskNode",
    _meta: { title: "Resize Image/Mask" },
  },
  "261:6": {
    inputs: { samples: ["261:223", 0], vae: ["261:7", 0] },
    class_type: "VAEDecode",
    _meta: { title: "VAE Decode" },
  },
  "261:223": {
    inputs: { trim_amount: ["261:247", 3], samples: ["261:19", 0] },
    class_type: "TrimVideoLatent",
    _meta: { title: "Trim Video Latent" },
  },
  "261:297": {
    inputs: { value: false },
    class_type: "PrimitiveBoolean",
    _meta: { title: "Boolean" },
  },
  "261:298": {
    inputs: { batch_index: 1, length: 4096, image: ["261:6", 0] },
    class_type: "ImageFromBatch",
    _meta: { title: "Get Image from Batch" },
  },
  "261:299": {
    inputs: { switch: ["261:297", 0], on_false: ["261:6", 0], on_true: ["261:298", 0] },
    class_type: "ComfySwitchNode",
    _meta: { title: "If/Else Switch" },
  },
} as const;

// Real character identity mostly comes from the reference image itself
// (fed directly into WanAnimate2ToVideo) — this text is supplementary
// conditioning, not the source of truth, so a generic description is safe
// for an arbitrary user-uploaded photo.
const DEFAULT_CHARACTER_PROMPT =
  "Character exactly as shown in the uploaded reference image — preserve original appearance, clothing, and proportions. Soft even lighting, plain background.";

// Keyed by studio_presets.category (admin-editable, free text) — presets
// tagged with a known category get a tailored prompt; anything else (or a
// custom-uploaded motion video) falls back to the generic prompt below.
const MOTION_PROMPTS_BY_CATEGORY: Record<string, string> = {
  dance: "A person doing energetic street dance with rhythmic steps and dynamic arm gestures, background stationary",
  runway: "A person walking a fashion runway with a confident, poised model walk, background stationary",
  action: "A person performing dynamic action movements with powerful, fluid motion, background stationary",
};
const DEFAULT_MOTION_PROMPT = "Natural human motion following the reference pose video, background stationary";

export type WanAnimateWorkflow = Record<
  string,
  { inputs: Record<string, unknown>; class_type: string; _meta?: { title: string } }
>;

export type BuildWorkflowParams = {
  prompt?: string | null;
  motionCategory?: string | null;
  referenceImageName: string;
  poseVideoName: string;
};

export function buildWanAnimateWorkflow({
  prompt,
  motionCategory,
  referenceImageName,
  poseVideoName,
}: BuildWorkflowParams): WanAnimateWorkflow {
  const workflow = structuredClone(WORKFLOW_TEMPLATE) as unknown as WanAnimateWorkflow;

  workflow["189"].inputs.image = referenceImageName;
  workflow["240"].inputs.file = poseVideoName;

  const trimmedPrompt = prompt?.trim();
  workflow["261:3"].inputs.text = trimmedPrompt
    ? `${DEFAULT_CHARACTER_PROMPT}\nAdditional direction: ${trimmedPrompt}`
    : DEFAULT_CHARACTER_PROMPT;

  workflow["261:222"].inputs.text =
    (motionCategory && MOTION_PROMPTS_BY_CATEGORY[motionCategory]) || DEFAULT_MOTION_PROMPT;

  return workflow;
}
