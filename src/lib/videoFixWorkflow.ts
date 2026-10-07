import "server-only";
import { buildCinematicWorkflow, type CinematicWorkflow } from "@/lib/cinematicWorkflow";
import type { CinematicMode } from "@/lib/cinematicPricing";
import type { DirectorRefRole } from "@/lib/directorPricing";

/**
 * 動画の部分修正（2026-10-07〜）のワークフロー。Director の参照モード（MiniMaxH3ReferenceToVideo）の条件づけに、
 * 元の動画の「窓」を VAE で潜在に戻したものを渡し、作り直す区間だけノイズマスク 1 にする。
 * ローカルで成立した組み方（D:\ComfyUI-ull\mvfix_51_6075_640.json）と同じ。
 *
 * 窓の長さ・寸法・区間（秒）は元の動画を読まないと決まらないので、ワーカー（modal_wan_animate_blackwell.py の
 * _video_fix_prepare）が下のノードに書き込む。ここでは仮の値を入れておく。ノード id はワーカーとの契約:
 *   105:111 窓の長さ（秒）／105:104 width・height／404 映像の時間マスク／412 音声の時間マスク（音声も作り直すときだけ）
 *
 * 音声:
 *   - keepAudio: 元の音声をそのまま固定し（ノイズマスク 0 ＋ MiniMaxH3AddGuide）、口を合わせる。歌・セリフの動画向け。
 *     貼り戻しでも元の音声をそのまま通す。
 *   - それ以外: 作り直す区間だけ音声も作り直す（ULLH3AudioTimeMask）。
 */
export const VIDEO_FIX_NODE = {
  duration: "105:111",
  i2v: "105:104",
  videoMask: "404",
  audioMask: "412",
} as const;

export type BuildVideoFixWorkflowParams = {
  mode: CinematicMode;
  /** 作り直す区間の指示（英語・完成した文）。参照の書き方（<Picture N>）は buildCinematicWorkflow が整える。 */
  prompt: string;
  /** ワーカーが窓から切り出して置くファイル名（ComfyUI の input）。 */
  videoName: string;
  audioName: string;
  /** 作り直しの直前のコマ（ワーカーが切り出す）。<Picture 1> として人物・場面の手がかりにする。 */
  refFrameName: string;
  /** 足した参照写真（ComfyUI の input 名）と使い方。最大 8 枚。 */
  extraReferenceImageNames?: string[];
  extraReferenceRoles?: DirectorRefRole[];
  keepAudio: boolean;
  jobId?: string;
  seed?: number;
  loraName?: string;
  loraStrength?: number;
};

export function buildVideoFixWorkflow(p: BuildVideoFixWorkflowParams): CinematicWorkflow {
  const wf = buildCinematicWorkflow({
    mode: p.mode,
    prompt: p.prompt,
    promptIsComplete: true,
    referenceImageName: p.refFrameName,
    referenceMode: true,
    extraReferenceImageNames: p.extraReferenceImageNames,
    extraReferenceRoles: p.extraReferenceRoles,
    // 窓の長さはワーカーが書き込む（105:111）。ここは仮の値。
    durationS: 10,
    rawImageWidth: 960,
    rawImageHeight: 544,
    jobId: p.jobId,
    seed: p.seed,
    loraName: p.loraName,
    loraStrength: p.loraStrength,
    // keepAudio なら Director の「持ち込み音声」と同じ組み方（200〜213）で窓の音声を固定する。
    audioName: p.keepAudio ? p.audioName : undefined,
  });
  wf["92"].inputs.filename_prefix = p.jobId ? `video_fix_${p.jobId}` : "video_fix";

  // 元の動画の窓 → 潜在 → 作り直す区間だけマスク 1
  wf["400"] = { inputs: { file: p.videoName }, class_type: "LoadVideo", _meta: { title: "Source Window" } };
  wf["401"] = { inputs: { video: ["400", 0] }, class_type: "GetVideoComponents", _meta: { title: "Source Frames" } };
  wf["403"] = {
    inputs: { pixels: ["401", 0], vae: ["105:11", 0] },
    class_type: "VAEEncode",
    _meta: { title: "VAE Encode (source)" },
  };
  wf[VIDEO_FIX_NODE.videoMask] = {
    inputs: { samples: ["403", 0], regen_start_seconds: 0, regen_end_seconds: -1, fps: 24, fade_tokens: 1 },
    class_type: "ULLVideoTimeMask",
    _meta: { title: "Video Time Mask" },
  };

  if (p.keepAudio) {
    // 200〜213 は buildCinematicWorkflow が作った。映像の潜在だけ元の動画のものに差し替える。
    wf["213"].inputs.video_latent = [VIDEO_FIX_NODE.videoMask, 0];
  } else {
    wf["410"] = { inputs: { audio: p.audioName }, class_type: "LoadAudio", _meta: { title: "Source Audio" } };
    wf["411"] = {
      inputs: { audio: ["410", 0], vae: ["105:24", 0] },
      class_type: "VAEEncodeAudio",
      _meta: { title: "VAE Encode Audio (source)" },
    };
    wf[VIDEO_FIX_NODE.audioMask] = {
      inputs: {
        samples: ["411", 0],
        video_latent: [VIDEO_FIX_NODE.videoMask, 0],
        regen_start_seconds: 0,
        regen_end_seconds: -1,
        fade_frames: 6,
      },
      class_type: "ULLH3AudioTimeMask",
      _meta: { title: "Audio Time Mask" },
    };
    wf["213"] = {
      inputs: { video_latent: [VIDEO_FIX_NODE.videoMask, 0], audio_latent: [VIDEO_FIX_NODE.audioMask, 0] },
      class_type: "LTXVConcatAVLatent",
      _meta: { title: "Concat AV Latent" },
    };
    wf["105:14"].inputs.latent_image = ["213", 0];
  }
  return wf;
}
