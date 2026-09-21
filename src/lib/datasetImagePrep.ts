// 取り込み時の画像サイズ検査と縮小（2026-09-21）。
//
// ワーカー側は sd-scripts の `bucket_no_upscale = true` で動く（ホストの
// ローカル実績構成と同じ）。つまり**小さい画像は引き伸ばされず、小さいまま
// 学習される**。黙っていると「なぜか甘い LoRA」になるだけなので、取り込みの
// 時点で短辺を測り、足りないものは当サイトの超解像へ誘導する。
//
// 逆に大きすぎる画像は、1024 学習では情報が使われないのにアップロード時間と
// 転送量だけを食う。長辺 MAX_LONG_EDGE を超えるものはブラウザ側で縮小する。
import { MAX_LONG_EDGE, MIN_SHORT_EDGE_ERROR, MIN_SHORT_EDGE_WARN } from "@/components/studio/LoraStudioTab.parts";

export type ImageSizeVerdict = "ok" | "small" | "tooSmall";

export type PreparedImage = {
  file: File;
  width: number;
  height: number;
  verdict: ImageSizeVerdict;
  /** 縮小した場合の元の長辺（表示用）。縮小していなければ undefined。 */
  shrunkFrom?: number;
};

function verdictFor(shortEdge: number): ImageSizeVerdict {
  if (shortEdge < MIN_SHORT_EDGE_ERROR) return "tooSmall";
  if (shortEdge < MIN_SHORT_EDGE_WARN) return "small";
  return "ok";
}

/**
 * 1枚を検査し、必要なら縮小して返す。
 * デコードに失敗した画像は素通しする（ここで落とすと原因が分かりにくい）。
 */
export async function prepareDatasetImage(file: File): Promise<PreparedImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return { file, width: 0, height: 0, verdict: "ok" };
  }
  const { width, height } = bmp;
  const longEdge = Math.max(width, height);
  const verdict = verdictFor(Math.min(width, height));

  if (longEdge <= MAX_LONG_EDGE) {
    bmp.close();
    return { file, width, height, verdict };
  }

  const scale = MAX_LONG_EDGE / longEdge;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    return { file, width, height, verdict };
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) return { file, width, height, verdict };
  const shrunk = new File([blob], file.name, { type: "image/png", lastModified: file.lastModified });
  // 縮小後の短辺で判定し直す（縮小で下限を割ることは設計上ないが念のため）。
  return { file: shrunk, width: w, height: h, verdict: verdictFor(Math.min(w, h)), shrunkFrom: longEdge };
}
