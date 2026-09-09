"use client";

// Multi-Angle Studio の参照画像を「アップロード前」に正規化する。
//
// 生の高解像度画像をそのまま multipart で送ると、デプロイ環境のリクエスト
// ボディ上限（Vercel は約 4.5MB）でボディが途中で打ち切られ、サーバー側の
// `request.formData()` が壊れて「リクエストの形式が正しくありません。」という
// 400 になる。「全 54 構図」を選ぶような本格的なターンアラウンド用途ほど
// 高解像度の参照を上げがちで、これが表面化しやすい。
//
// Qwen-Image-Edit は内部でおおむね ~1MP 前後に落とすので、長辺 1536px への
// 縮小＋WebP/JPEG 再エンコードで実質的な画質劣化はほぼなく、ペイロードは
// 数百KB に収まる。EXIF 回転はここで焼き込む（スマホ縦写真対策）。

const MAX_EDGE = 1536;
// multipart のヘッダ・境界オーバーヘッドを載せてもデプロイ環境の上限に
// 収まるよう、素の画像バイトはこの辺りを狙う。
const TARGET_BYTES = 3.5 * 1024 * 1024;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.7];

const PASSTHROUGH_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type NormalizedImage = {
  /** アップロードする画像本体（縮小不能なら元 File のまま）。 */
  blob: Blob;
  /** multipart に付けるファイル名。 */
  filename: string;
};

function pickFilename(type: string, fallback: string): string {
  if (type === "image/webp") return "reference.webp";
  if (type === "image/jpeg") return "reference.jpg";
  if (type === "image/png") return "reference.png";
  return fallback || "reference.png";
}

export async function normalizeAngleReferenceImage(file: File): Promise<NormalizedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // デコード不能（HEIC 等）。そのまま送り、サーバー側のデコードエラーに委ねる。
    return { blob: file, filename: file.name || pickFilename(file.type, "reference.png") };
  }

  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > 0 ? Math.min(1, MAX_EDGE / longEdge) : 1;

    // 元がすでに小さく、素直に送れる形式ならそのまま。
    if (scale === 1 && file.size <= TARGET_BYTES && PASSTHROUGH_TYPES.has(file.type)) {
      return { blob: file, filename: file.name || pickFilename(file.type, "reference.png") };
    }

    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      return { blob: file, filename: file.name || pickFilename(file.type, "reference.png") };
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

    // 再エンコードで却ってサイズが増える（すでに最適化済みの小さい JPEG など）
    // 場合は、縮小が要らないなら元を使う。
    if (best && (scale < 1 || best.size < file.size)) {
      return { blob: best, filename: pickFilename(mime, "reference.webp") };
    }
    return { blob: file, filename: file.name || pickFilename(file.type, "reference.png") };
  } finally {
    bitmap.close?.();
  }
}
