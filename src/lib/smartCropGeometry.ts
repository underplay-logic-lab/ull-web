// Pure geometry for LoRA Studio's Smart Crop feature — no DOM/canvas here so
// the crop-box math stays trivially testable and reusable from both the
// detection pipeline (src/lib/smartCrop.ts) and (if ever needed) a Node test.
// All inputs/outputs are plain pixel coordinates in source-image space.

export type Point = { x: number; y: number };
export type Box = { left: number; top: number; width: number; height: number };

/** Rounds up to the nearest multiple of `m` (never below `m` itself). */
export function roundUpToMultiple(n: number, m: number): number {
  return Math.max(m, Math.ceil(n / m) * m);
}

/** Rounds to the nearest multiple of `m` (never below `m` itself). */
export function roundToMultiple(n: number, m: number): number {
  return Math.max(m, Math.round(n / m) * m);
}

/**
 * Fits `box` inside the `imgW`x`imgH` frame WITHOUT changing its size —
 * translate first, and only shrink (uniformly, keeping the centre) if the
 * box is bigger than the image itself. Preferred over a naive per-edge
 * clamp, which would silently break the caller's intended aspect ratio by
 * clipping only the edges that happen to overflow.
 */
export function clampBoxToImage(box: Box, imgW: number, imgH: number): Box {
  let { width, height } = box;
  const cx = box.left + width / 2;
  const cy = box.top + height / 2;
  if (width > imgW || height > imgH) {
    const scale = Math.min(imgW / width, imgH / height);
    width *= scale;
    height *= scale;
  }
  let left = cx - width / 2;
  let top = cy - height / 2;
  left = Math.min(Math.max(left, 0), imgW - width);
  top = Math.min(Math.max(top, 0), imgH - height);
  return { left, top, width, height };
}

/** A square box centred at (cx, cy), extending `up` above and `down` below. */
export function squareFromCenter(cx: number, cy: number, up: number, down: number): Box {
  const side = up + down;
  return { left: cx - side / 2, top: cy - up, width: side, height: side };
}

/**
 * Grows (never shrinks) `box` to match `ratioW`:`ratioH`, expanding the
 * shorter dimension symmetrically around the existing centre. Only ever
 * adds margin, so it never clips content the caller already decided to
 * include.
 */
export function fitBoxToAspect(box: Box, ratioW: number, ratioH: number): Box {
  const targetRatio = ratioW / ratioH;
  const curRatio = box.width / box.height;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  let { width, height } = box;
  if (curRatio < targetRatio) {
    width = height * targetRatio;
  } else if (curRatio > targetRatio) {
    height = width / targetRatio;
  }
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}

const EYE_UP_MULT = 2.5; // headroom above the eye/nose centroid — covers hair
const EYE_DOWN_MULT = 1.8; // below the centroid — covers the neck/collar

/** ① 顔クローズアップ: 両目+鼻の重心を中心に、目間距離基準の正方形。 */
export function computeFaceCropBox(eyeA: Point, eyeB: Point, nose: Point): Box {
  const dEye = Math.hypot(eyeA.x - eyeB.x, eyeA.y - eyeB.y);
  const cx = (eyeA.x + eyeB.x + nose.x) / 3;
  const cy = (eyeA.y + eyeB.y + nose.y) / 3;
  return squareFromCenter(cx, cy, EYE_UP_MULT * dEye, EYE_DOWN_MULT * dEye);
}

// 頭頂部からさらに上へ取る余白。2026-09-22 に 0.1 -> 0.18 へ。頭頂部の位置は
// 推定値なので、足りないと顔が切れる（取り返しがつかない）一方、多すぎても
// 背景が少し入るだけで害が小さい。非対称なコストなので余裕を持たせる。
const UPPER_TOP_MARGIN_RATIO = 0.18;
const UPPER_SHOULDER_WIDTH_MULT = 1.6;
const UPPER_ASPECT_W = 3;
const UPPER_ASPECT_H = 4;

/**
 * ② 上半身/バストアップ: 頭頂部〜腰（または肘最下点、より低い方）を縦域、
 * 肩幅×1.6を横域として求めた矩形を 3:4 に整形する。
 */
export function computeUpperBodyCropBox(params: {
  headTop: Point;
  leftShoulder: Point;
  rightShoulder: Point;
  midHip: Point;
  lowestElbowY?: number;
}): Box {
  const { headTop, leftShoulder, rightShoulder, midHip, lowestElbowY } = params;
  const shoulderCx = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderWidth = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y);
  const bodyHeight = Math.max(midHip.y - headTop.y, 1);
  const top = headTop.y - UPPER_TOP_MARGIN_RATIO * bodyHeight;
  const bottom = lowestElbowY != null ? Math.max(midHip.y, lowestElbowY) : midHip.y;
  const width = shoulderWidth * UPPER_SHOULDER_WIDTH_MULT;
  const box: Box = { left: shoulderCx - width / 2, top, width, height: bottom - top };
  return fitBoxToAspect(box, UPPER_ASPECT_W, UPPER_ASPECT_H);
}

const FULLBODY_MARGIN_RATIO = 0.08;

/**
 * ③ 全身: 可視キーポイント群のバウンディングボックス＋余白。`headTop` を渡すと
 * （Face Landmarker が検出できた場合）頭頂部をそのまま上端に使い、
 * 肩・頭の推定誤差を避ける。
 */
export function computeFullBodyCropBox(points: Point[], headTop?: Point): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  if (headTop) ys.push(headTop.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const mx = w * FULLBODY_MARGIN_RATIO;
  const my = h * FULLBODY_MARGIN_RATIO;
  return { left: minX - mx, top: minY - my, width: w + 2 * mx, height: h + 2 * my };
}

export const SMART_CROP_OUTPUT_SIZE = {
  face: { width: 1024, height: 1024 },
  upper: { width: 768, height: 1024 },
} as const;

/**
 * 全身クロップの出力解像度: 長辺 1024px・短辺は 64 の倍数に丸める
 * （spec の「1024x1024, 768x1024 等」の例に倣う）。box のアスペクト比に
 * 最も近い 64 刻みの短辺を選ぶ。
 */
export function fullBodyOutputSize(box: Box): { width: number; height: number } {
  const long = 1024;
  const aspect = box.width / box.height;
  if (aspect >= 1) {
    return { width: long, height: roundToMultiple(long / aspect, 64) };
  }
  return { width: roundToMultiple(long * aspect, 64), height: long };
}
