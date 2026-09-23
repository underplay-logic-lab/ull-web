import crypto from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { presignPublishedArtifact } from "@/lib/r2.server";

// Multi-Angle の結果配信（2026-09-18導入）。
//
// 旧実装は modal_angle_worker.py が Supabase Storage の angle-results
// バケット（公開）へ各構図のPNGを upsert し、angle_jobs.images 配列に
// その公開URLをそのまま蓄積していた。閲覧・ダウンロードのたびにSupabase側
// の送信量としてカウントされる（CLAUDE.md §1「大容量バイナリはSupabaseを
// 経由させない」標準を参照）。
//
// 新実装は、ワーカーが Volume（angle_results/<user_id>/<job_id>/<index>.png）
// へ直接保存し、images 配列にはURLではなくそのVolume相対パスを保存する。
// このルートはジョブ1件ぶんの images 配列を丸ごと読み、Volume相対パスの
// 要素だけを署名付きModal URLへ差し替えて返す（http(s)/data: の要素は
// そのまま素通し — 移行前の旧行との混在に対応）。
// modal_angle_worker.py::download_angle_image が署名を検証する
// （_verify_angle_download_token）。
//
// Multi-Angleは1ジョブに最大96枚の画像を持ちうるため、画像1枚ごとに
// 個別エンドポイントを叩く設計（超解像/Directorと同じ「1結果=1ファイル」
// パターン）にはせず、ジョブ単位で一括署名する。フロント側
// （src/lib/angleApi.ts::resolveAngleImages）はこの結果をVolume相対パス
// 文字列をキーにキャッシュし、既に解決済みの画像については再度このルート
// を呼ばない。
export const maxDuration = 30;

const DOWNLOAD_TOKEN_TTL_SECONDS = 900;

function isVolumePath(v: string): boolean {
  return !/^https?:\/\//i.test(v) && !v.startsWith("data:");
}

function signDownloadToken(userId: string, jobId: string, file: string, expiresAt: number, secret: string): string {
  const payload = `${userId}:${jobId}:${file}:${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  if (!jobId) {
    return NextResponse.json({ error: "パラメータが不正です。" }, { status: 400 });
  }

  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }
  const userId = userData.user.id;
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = Boolean(userData.user.email && adminEmails.includes(userData.user.email.toLowerCase()));

  const { data: job, error } = (await supabaseAdmin
    .from("angle_jobs")
    .select("images, user_id, metadata")
    .eq("id", jobId)
    .maybeSingle()) as {
    data: { images: unknown; user_id: string; metadata: unknown } | null;
    error: { message: string } | null;
  };

  if (error) {
    console.error("[studio/angle/images] job lookup failed:", error.message);
    return NextResponse.json({ error: "ジョブの取得に失敗しました。" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  if (job.user_id !== userId && !isAdmin) {
    return NextResponse.json({ error: "このジョブの画像を取得する権限がありません。" }, { status: 403 });
  }
  const ownerId = job.user_id;
  const rawImages = Array.isArray(job.images) ? job.images.filter((v): v is string => typeof v === "string") : [];

  const modalUrl = process.env.MODAL_ANGLE_IMAGE_DOWNLOAD_URL;
  const modalAuthToken = process.env.MODAL_AUTH_TOKEN;
  if (rawImages.some(isVolumePath) && (!modalUrl || !modalAuthToken)) {
    return NextResponse.json({ error: "サーバー設定エラーです（Modal未設定）。" }, { status: 500 });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SECONDS;
  // 2026-09-23〜（R2 移行 計画 3）: worker の CPU publish が終わった構図は
  // metadata.r2_keys に入る → R2 の署名付き GET（15 分）。publish が途中でも
  // 上がった分だけ R2、残りは Modal（Volume）で、ユーザーからは切れ目なし。
  const r2Urls = await Promise.all(
    rawImages.map((raw) => (isVolumePath(raw) ? presignPublishedArtifact(job.metadata, raw) : Promise.resolve(null))),
  );
  const images = rawImages.map((raw, i) => {
    if (!isVolumePath(raw)) return raw;
    const r2Url = r2Urls[i];
    if (r2Url) return r2Url;
    const filename = raw.split("/").pop() ?? "";
    if (!/^[0-9]{2}\.png$/.test(filename) || !modalUrl || !modalAuthToken) return raw;
    const sig = signDownloadToken(ownerId, jobId, filename, expiresAt, modalAuthToken);
    const target = new URL(modalUrl);
    target.searchParams.set("user_id", ownerId);
    target.searchParams.set("job_id", jobId);
    target.searchParams.set("filename", filename);
    target.searchParams.set("expires", String(expiresAt));
    target.searchParams.set("sig", sig);
    return target.toString();
  });

  return NextResponse.json({ images });
}
