"use client";

// 超解像スタジオの入力画像を「アップロード前」に正規化する。
//
// 生の高解像度画像をそのまま送るとデプロイ環境のリクエストボディ上限
// （Vercel 約 4.5MB）でボディが打ち切られる。SeedVR2 worker は入力を内部で
// 長辺 2048px（ull_image_prep の INPUT_IMG_MAX_EDGE）へ落とすので、
// クライアント側で長辺 2048px へ縮小してもパイプライン上の劣化はない。
// すでに小さい PNG/JPEG/WebP はそのまま通す（超解像の入力なので再エンコードは
// 最小限に）。EXIF 回転はここで焼き込む。

const MAX_EDGE = 2048; // = modal_seedvr2_worker.py INPUT_IMG_MAX_EDGE
const TARGET_BYTES = 3.8 * 1024 * 1024;
const QUALITY_STEPS = [0.95, 0.9, 0.84, 0.78];

const PASSTHROUGH_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type NormalizedUpscaleInput = {
  blob: Blob;
  filename: string;
  /** 正規化後の寸法（課金見積り用。取れなければ null）。 */
  width: number | null;
  height: number | null;
};

function pickFilename(type: string): string {
  if (type === "image/webp") return "input.webp";
  if (type === "image/jpeg") return "input.jpg";
  return "input.png";
}

export async function normalizeUpscaleInput(file: File): Promise<NormalizedUpscaleInput> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { blob: file, filename: file.name || "input.png", width: null, height: null };
  }

  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > 0 ? Math.min(1, MAX_EDGE / longEdge) : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    if (scale === 1 && file.size <= TARGET_BYTES && PASSTHROUGH_TYPES.has(file.type)) {
      return { blob: file, filename: file.name || pickFilename(file.type), width: w, height: h };
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      return { blob: file, filename: file.name || pickFilename(file.type), width: w, height: h };
    }
    ctx.drawImage(bitmap, 0, 0, w, h);

    const supportsWebp = canvas.toDataURL("image/webp").startsWith("data:image/webp");
    const mime = supportsWebp ? "image/webp" : "image/jpeg";

    let best: Blob | null = null;
    for (const q of QUALITY_STEPS) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, q));
      if (!blob) continue;
      best = blob;
      if (blob.size <= TARGET_BYTES) break;
    }
    canvas.width = 0;
    canvas.height = 0;

    if (best && (scale < 1 || best.size < file.size)) {
      return { blob: best, filename: pickFilename(mime), width: w, height: h };
    }
    return { blob: file, filename: file.name || pickFilename(file.type), width: w, height: h };
  } finally {
    bitmap.close?.();
  }
}
