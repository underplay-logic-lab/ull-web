"use client";

// LoRA Studio Smart Crop — 骨格・顔ランドマーク検出レイヤー。
//
// 採用: @mediapipe/tasks-vision 1.0.1（Google, Apache-2.0、確認日
// 2026-09-14）。完全ブラウザ内WASM推論で、サーバー/GPUを一切使わない
// （このタスクは数枚の画像に対する軽量な座標検出であり、CLAUDE.md §0の
// 「よそでは出来ないこと」に該当する重い生成処理ではないため、Modal GPU
// ワーカーを新設する理由がない）。WASMランタイムとモデル本体は Google公式
// CDN から取得する（このアプリはArtifactではないため外部CDN制限は無い）。
//
// Face Landmarker: 478点の顔メッシュ（虹彩10点含む）。使うのは
//   - 468/473: 左右虹彩中心（両目中心・目間距離の基準）
//   - 1: 鼻先
//   - 10: 額上部（頭頂部の近似 — 実際の生え際はさらに上にあるが、
//     顔クロップのマージン計算(2.5×目間距離)側で髪型を含めるように
//     余白を取っているので、ここでは「顔の上端の目安点」で十分）
// これらは MediaPipe Face Mesh の公式トポロジで長年安定しているインデックス。
//
// Pose Landmarker（lite・軽量版）: BlazePose 33点。使うのは
//   0=鼻, 11/12=左右肩, 13/14=左右肘, 23/24=左右腰, 27/28=左右足首。
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export const FACE_LM = { irisA: 468, irisB: 473, nose: 1, chin: 152, forehead: 10 } as const;
export const POSE_LM = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftHip: 23,
  rightHip: 24,
  leftAnkle: 27,
  rightAnkle: 28,
} as const;

const MIN_VISIBILITY = 0.4;

// モデルロードは数MB〜数十MBあり数秒かかるため、タブ内で使い回すシングルトン
// として1回だけ初期化する（同時に複数画像を処理してもロードは1回だけ）。
let faceLandmarkerPromise: Promise<import("@mediapipe/tasks-vision").FaceLandmarker> | null = null;
let poseLandmarkerPromise: Promise<import("@mediapipe/tasks-vision").PoseLandmarker> | null = null;

async function getFaceLandmarker() {
  if (!faceLandmarkerPromise) {
    faceLandmarkerPromise = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "CPU" },
        runningMode: "IMAGE",
        numFaces: 1,
      });
    })();
  }
  return faceLandmarkerPromise;
}

async function getPoseLandmarker() {
  if (!poseLandmarkerPromise) {
    poseLandmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "CPU" },
        runningMode: "IMAGE",
        numPoses: 1,
      });
    })();
  }
  return poseLandmarkerPromise;
}

// 事前ロード用（スマートクロップボタンを押す前にバックグラウンドで温めておき、
// 実行時の初回待ちを減らす）。失敗しても実行時に再試行されるので無視してよい。
export function warmSmartCropModels(): void {
  void getFaceLandmarker().catch(() => {});
  void getPoseLandmarker().catch(() => {});
}

export type SmartCropLandmarks = {
  face: NormalizedLandmark[] | null;
  pose: NormalizedLandmark[] | null;
};

export function isLandmarkVisible(lm: NormalizedLandmark | undefined): lm is NormalizedLandmark {
  return Boolean(lm) && (lm!.visibility === undefined || lm!.visibility >= MIN_VISIBILITY);
}

export async function detectSmartCropLandmarks(image: HTMLImageElement): Promise<SmartCropLandmarks> {
  const [faceLandmarker, poseLandmarker] = await Promise.all([getFaceLandmarker(), getPoseLandmarker()]);
  let face: NormalizedLandmark[] | null = null;
  let pose: NormalizedLandmark[] | null = null;
  try {
    const result = faceLandmarker.detect(image);
    face = result.faceLandmarks?.[0] ?? null;
  } catch (err) {
    console.error("[smartCropDetect] face detection failed:", err);
  }
  try {
    const result = poseLandmarker.detect(image);
    pose = result.landmarks?.[0] ?? null;
  } catch (err) {
    console.error("[smartCropDetect] pose detection failed:", err);
  }
  return { face, pose };
}
