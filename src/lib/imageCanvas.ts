"use client";

// Canvas helpers backing the Cinematic Video tab's crop + forced-resize
// pipeline (see ImageCropper.tsx and CinematicVideoTab.tsx). Browser-only —
// never imported from server code.

export type PixelCrop = { x: number; y: number; width: number; height: number };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    img.crossOrigin = "anonymous";
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

// Extracts the region react-easy-crop reports (in source-image pixel
// coordinates) as its own image, at that region's native resolution — no
// resizing yet, so cropping and the mode-driven target-size resize
// (resizeImageBlobTo) stay independent steps.
export async function getCroppedImageBlob(imageSrc: string, cropPixels: PixelCrop): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cropPixels.width);
  canvas.height = Math.round(cropPixels.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context を取得できませんでした。");

  ctx.drawImage(
    image,
    cropPixels.x,
    cropPixels.y,
    cropPixels.width,
    cropPixels.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return canvasToBlob(canvas);
}

// Forces `blob` to exactly `width`x`height` (both expected to already be
// 16-multiples — see cinematicTargetDimensions). Used right before upload
// so the payload always matches the selected quality mode's resolution
// regardless of the crop's own native size.
export async function resizeImageBlobTo(blob: Blob, width: number, height: number): Promise<Blob> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(objectUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context を取得できませんでした。");
    ctx.drawImage(image, 0, 0, width, height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
