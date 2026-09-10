// 依存なしで PNG / JPEG / WebP / GIF / BMP のピクセル寸法をバイト列から読む。
// 超解像スタジオの API 経路で、入力画像の寸法から消費クレジットを算出するのに
// 使う（クライアント申告値は信用しない）。デコードはしない（ヘッダのみ）。

export type ImageDimensions = { width: number; height: number };

export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;

  // --- PNG: \x89PNG\r\n\x1a\n ... IHDR(width u32be, height u32be) ---
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    // IHDR は先頭チャンク: 8(sig) + 4(len) + 4("IHDR") = offset 16 から width/height。
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }

  // --- GIF87a / GIF89a: 'GIF' + version + width u16le + height u16le ---
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }

  // --- BMP: 'BM' ... DIB header @14: width i32le, height i32le ---
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    const width = Math.abs(buf.readInt32LE(18));
    const height = Math.abs(buf.readInt32LE(22));
    if (width > 0 && height > 0) return { width, height };
    return null;
  }

  // --- WebP: 'RIFF' .... 'WEBP' then a chunk (VP8 / VP8L / VP8X) ---
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const fourCC = buf.toString("ascii", 12, 16);
    if (fourCC === "VP8 ") {
      // Lossy: 3-byte start code (0x9d 0x01 0x2a) at offset 23, then w/h 14-bit.
      if (buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      }
    } else if (fourCC === "VP8L") {
      // Lossless: 1 signature byte (0x2f) then 14-bit w-1 / 14-bit h-1 packed.
      if (buf.length >= 25) {
        const b0 = buf[21];
        const b1 = buf[22];
        const b2 = buf[23];
        const b3 = buf[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        if (width > 0 && height > 0) return { width, height };
      }
    } else if (fourCC === "VP8X") {
      // Extended: canvas w-1 / h-1 as 24-bit LE at offsets 24 / 27.
      if (buf.length >= 30) {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        if (width > 0 && height > 0) return { width, height };
      }
    }
    return null;
  }

  // --- JPEG: scan SOFn markers ---
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      // Standalone markers (no length): RSTn, SOI, EOI, TEM.
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01 ||
        marker === 0xff
      ) {
        offset += 2;
        continue;
      }
      const segLen = buf.readUInt16BE(offset + 2);
      // SOF0..SOF15 except DHT(0xc4) / JPG(0xc8) / DAC(0xcc).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { width, height };
        return null;
      }
      offset += 2 + segLen;
    }
    return null;
  }

  return null;
}
