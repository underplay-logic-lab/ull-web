import "server-only";
import crypto from "crypto";
import { presignPublishedArtifact } from "@/lib/r2.server";

// ULL Cinematic Director: 生成済み動画の配信（2026-09-18導入）。
//
// 旧実装は modal_wan_animate_blackwell.py が Supabase Storage の
// director-results バケット（公開）へ mp4 を upsert し、generation_jobs.
// video_url にその公開URLをそのまま永続化していた。閲覧・ダウンロードの
// たびにSupabase側の送信量としてカウントされ、動画は容量が大きいため
// Freeプランの月間5GBクォータを圧迫する主因の一つだった（CLAUDE.md §1
// 「大容量バイナリはSupabaseを経由させない」標準を参照）。
//
// 新実装は、ワーカーが Volume（director_results/<user_id>/<job_id>.mp4）へ
// 直接保存し、video_url カラムにはURLではなくそのVolume相対パスを保存する。
// 配信時はこのファイルが短命の署名付きトークンを発行し、ブラウザが
// modal_wan_animate_blackwell.py::download_director_video を直接叩いて
// 単一ホップでストリームを受け取る（download_lora_checkpoint と同じ
// HMAC-SHA256方式、_verify_director_video_token が検証する）。

const DOWNLOAD_TOKEN_TTL_SECONDS = 900; // 15分（LoRAチェックポイントのダウンロードトークンと同じ長さ）

/** video_url カラムの値が「実URL（旧方式の名残）」か「Volume相対パス
 * （新方式）」かを判定する。http(s) で始まらなければ新方式とみなす。 */
export function isDirectorVideoVolumePath(videoUrl: string): boolean {
  return !/^https?:\/\//i.test(videoUrl);
}

/** Volume相対パスから、ブラウザが直接叩ける署名付きダウンロードURLを
 * 発行する。userId/jobId は呼び出し元（/api/jobs/[id]）が既に所有権確認
 * 済みのジョブ行から渡すこと。 */
export function signDirectorVideoUrl(userId: string, jobId: string): string | null {
  const downloadUrl = process.env.MODAL_DIRECTOR_VIDEO_DOWNLOAD_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!downloadUrl || !authToken) {
    console.error("[directorVideoDownload] MODAL_DIRECTOR_VIDEO_DOWNLOAD_URL または MODAL_AUTH_TOKEN が未設定です。");
    return null;
  }
  const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", authToken)
    .update(`director-video:${userId}:${jobId}:${expiresAt}`)
    .digest("hex");

  const target = new URL(downloadUrl);
  target.searchParams.set("user_id", userId);
  target.searchParams.set("job_id", jobId);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);
  return target.toString();
}

/** 2026-09-23〜（R2 移行 計画 3）: worker の CPU publish が R2 へ上げ終わった
 * 行は metadata.r2_keys に `director_results/<user_id>/<job_id>.mp4` が入る →
 * R2 の署名付き GET（15 分）。まだ Volume にある行は従来の Modal 直リンク。
 * <video src> と fetch→blob の両方で使うので attachment は付けない。 */
export async function resolveDirectorVideoUrl(userId: string, jobId: string, metadata: unknown): Promise<string | null> {
  const relPath = `director_results/${userId}/${jobId}.mp4`;
  const r2Url = await presignPublishedArtifact(metadata, relPath, { contentType: "video/mp4" });
  return r2Url ?? signDirectorVideoUrl(userId, jobId);
}
