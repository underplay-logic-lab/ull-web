import "server-only";
import crypto from "crypto";
import { presignR2Put, r2UploadsEnabled } from "@/lib/r2.server";

// LoRA学習用データセット画像の直アップロード用チケット発行（2026-09-19
// 導入）。Supabase Storage バケット "lora_datasets" から
// modal_lora_worker.py::upload_lora_dataset_image への移行（CLAUDE.md §1
// 標準）。HMAC方式は studioUploadTicket.server.ts / directorLoraUpload.
// server.ts と同じ（鍵: MODAL_AUTH_TOKEN）だが、1データセットにつき最大
// 500枚を1枚ずつPOSTするため、ファイル名ごとではなく dataset_id 単位で
// まとめて署名する（Next.jsへの往復を1回に抑える）。
//
// 2026-09-23（R2 移行 計画 4）: 既定はブラウザ → R2 直 PUT（store: "r2"）。
// 署名付き PUT URL はオブジェクトごとに要るので、ブラウザが送るファイル名の
// 一覧を受け取り、1 枚ずつ URL を返す（500 枚でも署名は CPU 内で完結し、
// Next.js への往復は変わらず 1 回）。キーは Volume と同じ
// `lora_dataset_uploads/<userId>/<datasetId>/<filename>` で、worker 側
// （_read_lora_dataset_upload）は Volume に無ければ R2 から読む。
// `UPLOAD_STORE=volume`（または R2 未設定）なら従来の Modal チケット。

const TICKET_TTL_SECONDS = 60 * 30; // 500枚の連続アップロードでも余裕のある30分
const R2_PUT_TTL_SECONDS = 60 * 60; // R2 直 PUT は URL ごとに独立なので 1 時間
const DATASET_ID_RE = /^[0-9a-fA-F-]{1,64}$/;
// modal_lora_worker.py::_DATASET_IMG_FILENAME_RE と同じ。
const DATASET_IMG_FILENAME_RE = /^[A-Za-z0-9._-]{1,140}\.(?:png|jpe?g|webp)$/i;
// /api/studio/lora/train/route.ts の MAX_IMAGES と同じ値。
export const LORA_DATASET_MAX_FILES = 500;

export type LoraDatasetUploadTicket =
  | {
      store: "r2";
      userId: string;
      datasetId: string;
      expiresAt: number;
      /** 要求されたファイル名の並びのまま。`path` は "<userId>/<datasetId>/<filename>"。 */
      files: { filename: string; path: string; url: string }[];
    }
  | {
      store: "modal";
      uploadUrl: string;
      // 複数枚を1リクエストで受ける upload_lora_dataset_batch のURL（2026-09-20）。
      // 単枚版のURLから導出できる形なので env は任意。Modal 側が未デプロイでも
      // ブラウザが 404/405 を見て単枚経路へ落ちる。
      batchUploadUrl?: string;
      userId: string;
      datasetId: string;
      expiresAt: number;
      sig: string;
    };

export function loraDatasetUploadR2Key(userId: string, datasetId: string, filename: string): string {
  return `lora_dataset_uploads/${userId}/${datasetId}/${filename}`;
}

export async function createLoraDatasetUploadTicket(
  userId: string,
  datasetId: string,
  filenames: string[] = [],
): Promise<LoraDatasetUploadTicket> {
  if (!DATASET_ID_RE.test(datasetId)) {
    throw new Error("不正な dataset_id です。");
  }

  if (r2UploadsEnabled() && filenames.length > 0) {
    if (filenames.length > LORA_DATASET_MAX_FILES) {
      throw new Error(`学習用画像は最大${LORA_DATASET_MAX_FILES}枚です。`);
    }
    const seen = new Set<string>();
    for (const name of filenames) {
      if (!DATASET_IMG_FILENAME_RE.test(name) || seen.has(name)) {
        throw new Error(`不正なファイル名です: ${name}`);
      }
      seen.add(name);
    }
    const expiresAt = Math.floor(Date.now() / 1000) + R2_PUT_TTL_SECONDS;
    const files = await Promise.all(
      filenames.map(async (filename) => ({
        filename,
        path: `${userId}/${datasetId}/${filename}`,
        url: await presignR2Put(loraDatasetUploadR2Key(userId, datasetId, filename), {
          expiresIn: R2_PUT_TTL_SECONDS,
        }),
      })),
    );
    return { store: "r2", userId, datasetId, expiresAt, files };
  }

  const uploadUrl = process.env.MODAL_LORA_DATASET_UPLOAD_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!uploadUrl) {
    throw new Error("MODAL_LORA_DATASET_UPLOAD_URL が未設定です（modal_lora_worker.py の upload_lora_dataset_image のURL）。");
  }
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  }
  // Modal の web エンドポイントURLは関数名から決まる（…--upload-lora-dataset-
  // image.modal.run）。env が無ければそこだけ差し替えて導出し、形が変わって
  // いたら batchUploadUrl を返さない（＝ブラウザは単枚経路のまま）。
  const derivedBatchUrl = uploadUrl.includes("upload-lora-dataset-image")
    ? uploadUrl.replace("upload-lora-dataset-image", "upload-lora-dataset-batch")
    : undefined;
  const batchUploadUrl = process.env.MODAL_LORA_DATASET_UPLOAD_BATCH_URL || derivedBatchUrl;

  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", authToken)
    .update(`lora-dataset-upload:${userId}:${datasetId}:${expiresAt}`)
    .digest("hex");
  return { store: "modal", uploadUrl, batchUploadUrl, userId, datasetId, expiresAt, sig };
}
