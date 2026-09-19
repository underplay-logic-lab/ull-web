import "server-only";
import crypto from "crypto";

// LoRA学習用データセット画像の直アップロード用チケット発行（2026-09-19
// 導入）。Supabase Storage バケット "lora_datasets" から
// modal_lora_worker.py::upload_lora_dataset_image への移行（CLAUDE.md §1
// 標準）。HMAC方式は studioUploadTicket.server.ts / directorLoraUpload.
// server.ts と同じ（鍵: MODAL_AUTH_TOKEN）だが、1データセットにつき最大
// 500枚を1枚ずつPOSTするため、ファイル名ごとではなく dataset_id 単位で
// まとめて署名する（Next.jsへの往復を1回に抑える）。

const TICKET_TTL_SECONDS = 60 * 30; // 500枚の連続アップロードでも余裕のある30分
const DATASET_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

export type LoraDatasetUploadTicket = {
  uploadUrl: string;
  userId: string;
  datasetId: string;
  expiresAt: number;
  sig: string;
};

export function createLoraDatasetUploadTicket(userId: string, datasetId: string): LoraDatasetUploadTicket {
  if (!DATASET_ID_RE.test(datasetId)) {
    throw new Error("不正な dataset_id です。");
  }
  const uploadUrl = process.env.MODAL_LORA_DATASET_UPLOAD_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!uploadUrl) {
    throw new Error("MODAL_LORA_DATASET_UPLOAD_URL が未設定です（modal_lora_worker.py の upload_lora_dataset_image のURL）。");
  }
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", authToken)
    .update(`lora-dataset-upload:${userId}:${datasetId}:${expiresAt}`)
    .digest("hex");
  return { uploadUrl, userId, datasetId, expiresAt, sig };
}
