import "server-only";
import { spawnAngleJob, type SpawnAngleJobParams } from "@/lib/modalAngle";
import { rememberAngleCall } from "@/lib/modalCallRecord.server";
import { downloadStudioUpload, deleteStudioUploads } from "@/lib/studioUploads.server";

/**
 * Multi-Angle のジョブを起動するのに要る引数（画像の本体は入れず置き場所だけ）。
 * 予約（studio_dispatch_specs.spec）にそのまま保存し、順番が来たら dispatchAngleJob で起動する。
 * 検証・翻訳・課金は予約の時点で済んでいる。
 */
export type AngleDispatchSpec = Omit<SpawnAngleJobParams, "jobId" | "userId" | "imagesBase64"> & {
  /** studio-uploads の置き場所（先頭がメイン）。起動するまで消さない。 */
  storagePaths: string[];
};

/**
 * Modal へ投げて実行 id を残す。imagesBase64 を渡せばそれを使い（その場で起動する通常の生成）、
 * 無ければ storagePaths から読み直す（予約からの起動）。読み終わったアップロードは消す。
 * 失敗したら throw（行の failed 化・返金は呼び出し側）。
 */
export async function dispatchAngleJob(
  jobId: string,
  userId: string,
  spec: AngleDispatchSpec,
  imagesBase64?: string[],
): Promise<void> {
  const { storagePaths, ...rest } = spec;
  let images = imagesBase64;
  if (!images) {
    const buffers: Buffer[] = [];
    for (const p of storagePaths) buffers.push(await downloadStudioUpload(userId, p));
    images = buffers.map((b) => b.toString("base64"));
  }
  const { callId } = await spawnAngleJob({ ...rest, jobId, userId, imagesBase64: images });
  deleteStudioUploads(storagePaths);
  // admin の中止ボタンが Modal の実行まで止められるよう、実行 id を残す（best-effort）。
  await rememberAngleCall(jobId, callId);
}
