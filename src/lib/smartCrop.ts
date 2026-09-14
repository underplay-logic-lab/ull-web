"use client";

// LoRA Studio Smart Crop — 骨格・顔ランドマークから「顔クローズアップ / 上半身
// / 全身」の3枚を幾何学的に切り出す。検出は src/lib/smartCropDetect.ts
// （MediaPipe, ブラウザ内WASM）、座標計算は src/lib/smartCropGeometry.ts
// （純関数・DOM非依存）に分離し、ここでは「画像を読み込む→検出する→
// 矩形を計算する→キャンバスに描画してFileへ戻す」というI/Oの配線だけを担う。
import {
  clampBoxToImage,
  computeFaceCropBox,
  computeFullBodyCropBox,
  computeUpperBodyCropBox,
  fullBodyOutputSize,
  type Box,
  type Point,
  SMART_CROP_OUTPUT_SIZE,
} from "@/lib/smartCropGeometry";
import {
  detectSmartCropLandmarks,
  FACE_LM,
  isLandmarkVisible,
  POSE_LM,
} from "@/lib/smartCropDetect";

export type SmartCropKind = "face" | "upper" | "full";

export type SmartCropOutput = {
  kind: SmartCropKind;
  file: File;
  width: number;
  height: number;
};

export const SMART_CROP_KIND_LABEL: Record<SmartCropKind, string> = {
  face: "顔",
  upper: "上半身",
  full: "全身",
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("画像の書き出しに失敗しました。"))),
      "image/png",
    );
  });
}

// クランプ後に box の縦横比が目標と大きくズレた場合（人物が画像端いっぱいで
// 余白を取れない等）は、平均端色でレターボックス的に埋める最終フォールバック。
// 見た目の破綻より学習データとしての解像度整合性（64の倍数）を優先する。
async function drawBoxToOutput(
  img: HTMLImageElement,
  box: Box,
  outWidth: number,
  outHeight: number,
): Promise<HTMLCanvasElement> {
  const clamped = clampBoxToImage(box, img.naturalWidth, img.naturalHeight);
  const targetRatio = outWidth / outHeight;
  const clampedRatio = clamped.width / clamped.height;

  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context を取得できませんでした。");

  if (Math.abs(clampedRatio - targetRatio) < 0.01) {
    ctx.drawImage(img, clamped.left, clamped.top, clamped.width, clamped.height, 0, 0, outWidth, outHeight);
    return canvas;
  }

  // アスペクト比がズレたケース: 収まる最大サイズで中央に描き、余白は
  // クロップ矩形の平均色で塗る（単色なのでキャプション上ノイズになりにくい）。
  const sample = document.createElement("canvas");
  sample.width = Math.max(1, Math.round(clamped.width));
  sample.height = Math.max(1, Math.round(clamped.height));
  const sctx = sample.getContext("2d");
  let fill = "#808080";
  if (sctx) {
    sctx.drawImage(img, clamped.left, clamped.top, clamped.width, clamped.height, 0, 0, sample.width, sample.height);
    try {
      const { data } = sctx.getImageData(0, 0, sample.width, sample.height);
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4 * 37) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
      if (n > 0) fill = `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
    } catch {
      /* CORS等でgetImageDataが失敗しても既定のグレーで続行 */
    }
  }
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, outWidth, outHeight);

  let drawW = outWidth;
  let drawH = drawW / clampedRatio;
  if (drawH > outHeight) {
    drawH = outHeight;
    drawW = drawH * clampedRatio;
  }
  const dx = (outWidth - drawW) / 2;
  const dy = (outHeight - drawH) / 2;
  ctx.drawImage(img, clamped.left, clamped.top, clamped.width, clamped.height, dx, dy, drawW, drawH);
  return canvas;
}

function toFile(canvas: HTMLCanvasElement, stem: string, kind: SmartCropKind): Promise<File> {
  return canvasToBlob(canvas).then(
    (blob) => new File([blob], `${stem}_${kind}.png`, { type: "image/png" }),
  );
}

function pt(lm: { x: number; y: number }, w: number, h: number): Point {
  return { x: lm.x * w, y: lm.y * h };
}

/**
 * 元画像を安全に64の倍数へ揃えるだけのフォールバック（人物が検出できな
 * かった場合。中心基準でトリムするだけでリサイズはしない — spec の
 * 「元画像サイズを維持してフォールバック」に対応）。
 */
async function fallbackAligned(img: HTMLImageElement, stem: string): Promise<SmartCropOutput[]> {
  const w = Math.max(64, Math.floor(img.naturalWidth / 64) * 64);
  const h = Math.max(64, Math.floor(img.naturalHeight / 64) * 64);
  const box: Box = {
    left: (img.naturalWidth - w) / 2,
    top: (img.naturalHeight - h) / 2,
    width: w,
    height: h,
  };
  const canvas = await drawBoxToOutput(img, box, w, h);
  return [{ kind: "full", file: await toFile(canvas, stem, "full"), width: w, height: h }];
}

/**
 * 画像1枚から「顔クローズアップ / 上半身 / 全身」を検出・幾何計算・描画する。
 * 人物が検出できない場合は元画像を64倍数に揃えた1枚のみを返す。
 */
export async function runSmartCrop(file: File): Promise<SmartCropOutput[]> {
  const objectUrl = URL.createObjectURL(file);
  const stem = file.name.replace(/\.[^.]+$/, "");
  try {
    const img = await loadImage(objectUrl);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const { face, pose } = await detectSmartCropLandmarks(img);

    if (!face && !pose) {
      return await fallbackAligned(img, stem);
    }

    const outputs: SmartCropOutput[] = [];
    let headTop: Point | undefined;

    if (face) {
      const eyeA = face[FACE_LM.irisA];
      const eyeB = face[FACE_LM.irisB];
      const nose = face[FACE_LM.nose];
      const forehead = face[FACE_LM.forehead];
      if (eyeA && eyeB && nose) {
        const box = computeFaceCropBox(pt(eyeA, w, h), pt(eyeB, w, h), pt(nose, w, h));
        const { width: outW, height: outH } = SMART_CROP_OUTPUT_SIZE.face;
        const canvas = await drawBoxToOutput(img, box, outW, outH);
        outputs.push({ kind: "face", file: await toFile(canvas, stem, "face"), width: outW, height: outH });
      }
      if (forehead) headTop = pt(forehead, w, h);
    }

    if (pose) {
      const leftShoulder = pose[POSE_LM.leftShoulder];
      const rightShoulder = pose[POSE_LM.rightShoulder];
      const leftHip = pose[POSE_LM.leftHip];
      const rightHip = pose[POSE_LM.rightHip];
      const leftElbow = pose[POSE_LM.leftElbow];
      const rightElbow = pose[POSE_LM.rightElbow];

      const shouldersOk = isLandmarkVisible(leftShoulder) && isLandmarkVisible(rightShoulder);
      const hipsOk = isLandmarkVisible(leftHip) && isLandmarkVisible(rightHip);

      if (shouldersOk && hipsOk) {
        const lS = pt(leftShoulder, w, h);
        const rS = pt(rightShoulder, w, h);
        const midHip: Point = {
          x: (pt(leftHip, w, h).x + pt(rightHip, w, h).x) / 2,
          y: (pt(leftHip, w, h).y + pt(rightHip, w, h).y) / 2,
        };
        // 頭頂部: Face Landmarker が取れていればそれを使う。無ければ肩幅から
        // 簡易推定（頭の高さ ≒ 肩幅×0.9 は成人の平均的な頭身比に基づく目安）。
        const estimatedHeadTop: Point = headTop ?? {
          x: (lS.x + rS.x) / 2,
          y: Math.min(lS.y, rS.y) - Math.hypot(lS.x - rS.x, lS.y - rS.y) * 0.9,
        };
        const lowestElbowY = [leftElbow, rightElbow]
          .filter(isLandmarkVisible)
          .map((e) => pt(e, w, h).y);

        const upperBox = computeUpperBodyCropBox({
          headTop: estimatedHeadTop,
          leftShoulder: lS,
          rightShoulder: rS,
          midHip,
          lowestElbowY: lowestElbowY.length ? Math.max(...lowestElbowY) : undefined,
        });
        const { width: uW, height: uH } = SMART_CROP_OUTPUT_SIZE.upper;
        const upperCanvas = await drawBoxToOutput(img, upperBox, uW, uH);
        outputs.push({ kind: "upper", file: await toFile(upperCanvas, stem, "upper"), width: uW, height: uH });

        const bodyPoints: Point[] = pose.filter(isLandmarkVisible).map((lm) => pt(lm, w, h));
        const fullBox = computeFullBodyCropBox(bodyPoints, headTop);
        const clampedFull = clampBoxToImage(fullBox, w, h);
        const { width: fW, height: fH } = fullBodyOutputSize(clampedFull);
        const fullCanvas = await drawBoxToOutput(img, fullBox, fW, fH);
        outputs.push({ kind: "full", file: await toFile(fullCanvas, stem, "full"), width: fW, height: fH });
      }
    }

    if (!outputs.length) return await fallbackAligned(img, stem);
    return outputs;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
