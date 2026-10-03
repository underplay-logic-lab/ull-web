import "server-only";
import { spawnUpscaleBatchJob, spawnUpscaleJob, spawnUpscaleVideoJob } from "@/lib/modalUpscale";
import { rememberUpscaleCall } from "@/lib/modalCallRecord.server";
import { createStudioUploadSignedUrl } from "@/lib/studioUploads.server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 超解像（画像 1 枚・まとめ・動画）の起動。予約（studio_dispatch_specs.spec）からも、その場の生成からも呼ぶ
// （2026-10-03、lib/studioQueue.server.ts）。署名 URL は期限が切れるので、置き場所を持って起動時に署名する。
// 入力のアップロードは消さない（worker が署名 URL を取りに行く前に消すと失敗する。14 日の自動削除に任せる）。

type UpscaleParams = Record<string, number | string | boolean>;

export type UpscaleImageSpec = {
  type: "single";
  storagePath: string;
  creditsCost: number;
  maxAllowedTime: number;
  modelKey: string;
  presetId: string;
  params: UpscaleParams;
};

export type UpscaleBatchSpec = {
  type: "batch";
  batchId: string;
  /** 推定合計秒数（cost-guard と署名の期限に使う）。 */
  maxAllowedTime: number;
  urlTtl: number;
  items: {
    jobId: string;
    storagePath: string;
    creditsCost: number;
    modelKey: string;
    presetId: string;
    params: UpscaleParams;
  }[];
};

export type UpscaleImageQueueSpec = UpscaleImageSpec | UpscaleBatchSpec;

export type UpscaleVideoSpec = {
  storagePath: string;
  urlTtl: number;
  creditsCost: number;
  maxAllowedTime: number;
  modelKey: string;
  presetId: string;
  params: UpscaleParams;
};

/** 画像 1 枚。image を渡せばそれ（base64 / 署名 URL）を使い、無ければ storagePath を署名する。 */
export async function dispatchUpscaleImage(
  jobId: string,
  userId: string,
  spec: UpscaleImageSpec,
  image?: string,
): Promise<void> {
  const src = image ?? (await createStudioUploadSignedUrl(userId, spec.storagePath));
  const { callId } = await spawnUpscaleJob({
    jobId,
    userId,
    creditsCost: spec.creditsCost,
    maxAllowedTime: spec.maxAllowedTime,
    image: src,
    modelKey: spec.modelKey,
    presetId: spec.presetId,
    params: spec.params,
  });
  // admin の中止ボタンが Modal の実行まで止められるよう、実行 id を残す（best-effort）。
  await rememberUpscaleCall({ jobId }, callId);
}

/**
 * まとめ（N 枚を 1 回で）。予約からの起動では、取り出した 1 行以外の同じまとめの行もここで起動中にする
 * （次の取り出しは「動いている行がある」ので止まる）。
 */
export async function dispatchUpscaleBatch(userId: string, spec: UpscaleBatchSpec): Promise<void> {
  await supabaseAdmin
    .from("upscale_jobs")
    .update({ status: "pending" })
    .eq("batch_id", spec.batchId)
    .eq("status", "reserved");
  const signed: string[] = [];
  for (let i = 0; i < spec.items.length; i += 16) {
    const chunk = spec.items.slice(i, i + 16);
    signed.push(...(await Promise.all(chunk.map((it) => createStudioUploadSignedUrl(userId, it.storagePath, spec.urlTtl)))));
  }
  const { callId } = await spawnUpscaleBatchJob({
    batchId: spec.batchId,
    userId,
    maxAllowedTime: spec.maxAllowedTime,
    items: spec.items.map((it, i) => ({
      jobId: it.jobId,
      creditsCost: it.creditsCost,
      image: signed[i],
      modelKey: it.modelKey,
      presetId: it.presetId,
      params: it.params,
    })),
  });
  await rememberUpscaleCall({ batchId: spec.batchId }, callId);
}

/** 動画。video を渡せばそれ（署名 URL）を使い、無ければ storagePath を署名する。 */
export async function dispatchUpscaleVideo(
  jobId: string,
  userId: string,
  spec: UpscaleVideoSpec,
  video?: string,
): Promise<void> {
  const src = video ?? (await createStudioUploadSignedUrl(userId, spec.storagePath, spec.urlTtl));
  const { callId } = await spawnUpscaleVideoJob({
    jobId,
    userId,
    creditsCost: spec.creditsCost,
    maxAllowedTime: spec.maxAllowedTime,
    video: src,
    modelKey: spec.modelKey,
    presetId: spec.presetId,
    params: spec.params,
  });
  await rememberUpscaleCall({ jobId }, callId);
}
