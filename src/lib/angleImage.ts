"use client";

// Multi-Angle Studio の参照画像を「アップロード前」に正規化する。
//
// Qwen-Image-Edit は内部でおおむね ~1MP 前後に落とすので、長辺 1536px への
// 縮小＋再エンコードでパイプライン上の劣化はない（帯域・アップロード時間の
// 節約）。EXIF 回転はここで焼き込む（スマホ縦写真対策）。
//
// 2026-09-12 以前はここでさらに「Vercel の約4.5MBリクエストボディ上限」に
// 収まるよう劣化圧縮するロジックがあったが、アップロードを Supabase Storage
// への直アップロード方式（uploadUpscaleAsset、CLAUDE.md §6）に変更した
// ことでその制約自体が無くなったため撤去した。

const MAX_EDGE = 1536;
const REENCODE_QUALITY = 0.92;

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

    // 元がすでに 1536px 以内でパススルー可能な形式ならそのまま。
    if (scale === 1 && PASSTHROUGH_TYPES.has(file.type)) {
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
    const best = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, REENCODE_QUALITY),
    );
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
