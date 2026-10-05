import "server-only";
import { spawnDirectorJob, type SpawnDirectorJobParams } from "@/lib/modalDirector";
import { rememberGenerationCall } from "@/lib/modalCallRecord.server";
import { downloadStudioUpload } from "@/lib/studioUploads.server";
import { presignR2Get } from "@/lib/r2.server";

/**
 * Cinematic Director のジョブを起動するのに要る引数（参照画像の本体は入れず置き場所だけ）。
 * 予約（studio_dispatch_specs.spec）にそのまま保存し、順番が来たら dispatchDirectorJob で起動する
 * （2026-10-03、lib/studioQueue.server.ts）。台本の合成・検査・課金は予約の時点で済んでいる。
 * 参照画像は作り直しでも使うので消さない（14 日の自動削除に任せる）。
 */
export type DirectorDispatchSpec = Omit<
  SpawnDirectorJobParams,
  "jobId" | "userId" | "referenceImageB64" | "loraUrl" | "extraFilesB64"
> & {
  storagePath: string;
  /** 持ち込み音声の置き場所と、ComfyUI の input での名前（ワークフローの LoadAudio と同じ）。起動の直前に読む。 */
  audioStoragePath?: string;
  audioName?: string;
  /** 「顔写真として使う」で足した写真の置き場所と ComfyUI の input での名前（ワークフローの LoadImage と同じ順）。 */
  extraRefStoragePaths?: string[];
  extraRefNames?: string[];
  /** 学習済み LoRA・持ち込み LoRA の R2 キー。起動の直前に署名する（予約の間に期限が切れないように）。 */
  loraR2Key?: string;
};

/** imageB64 を渡せばそれを使い（その場で起動する通常の生成）、無ければ storagePath から読み直す（予約からの起動）。 */
export async function dispatchDirectorJob(
  jobId: string,
  userId: string,
  spec: DirectorDispatchSpec,
  imageB64?: string,
): Promise<void> {
  const { storagePath, loraR2Key, audioStoragePath, audioName, extraRefStoragePaths, extraRefNames, ...rest } = spec;
  const b64 = imageB64 ?? (await downloadStudioUpload(userId, storagePath)).toString("base64");
  // 参照写真の後ろに音声（ワーカーは files_b64 の先頭を参照画像として扱う）。
  const extraFilesB64: Record<string, string> = {};
  const refs = (extraRefStoragePaths ?? []).map((p, i) => [p, extraRefNames?.[i]] as const);
  const refData = await Promise.all(refs.map(([p]) => downloadStudioUpload(userId, p)));
  refs.forEach(([, name], i) => {
    if (name) extraFilesB64[name] = refData[i].toString("base64");
  });
  if (audioStoragePath && audioName) {
    extraFilesB64[audioName] = (await downloadStudioUpload(userId, audioStoragePath)).toString("base64");
  }
  // ワーカーはコールドスタート後に取りに行くので、署名は長め（1 時間）。
  const loraUrl = loraR2Key ? await presignR2Get(loraR2Key, { expiresIn: 60 * 60 }) : undefined;
  const { callId } = await spawnDirectorJob({
    ...rest,
    jobId,
    userId,
    referenceImageB64: b64,
    extraFilesB64: Object.keys(extraFilesB64).length ? extraFilesB64 : undefined,
    loraUrl,
  });
  // admin の中止ボタンが Modal の実行まで止められるよう、実行 id を残す（best-effort）。
  await rememberGenerationCall(jobId, callId);
}
