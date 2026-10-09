import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { probeUpscaleVideo } from "@/lib/modalUpscale";
import { createStudioUploadSignedUrl } from "@/lib/studioUploads.server";
import { VIDEO_PROBE_LIMIT, rateLimitResponse } from "@/lib/rateLimit.server";

// 動画超解像: 選んだ動画（アップロード済み）を ffprobe で測って返すだけ（2026-10-09）。
// ブラウザは fps を取れず 30 を仮定するので、画面の料金の目安が実際の課金とずれていた
// （24fps・243 コマで目安 112C／課金 102C）。課金は generate route が改めて測るので、
// ここの値は表示にしか使わない（クライアントから送り返された値は信用しない）。
export const maxDuration = 60;

const SIGNED_URL_EXPIRES_S = 10 * 60;

export async function POST(request: Request) {
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }
  const { data: userData, error: userError } = await createClient(supabaseUrl, anonKey).auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }
  const user = userData.user;

  const limited = await rateLimitResponse(user.id, VIDEO_PROBE_LIMIT);
  if (limited) return limited;

  const body = (await request.json().catch(() => null)) as { storagePath?: unknown } | null;
  const storagePath = typeof body?.storagePath === "string" ? body.storagePath : "";
  if (!storagePath) {
    return NextResponse.json({ error: "動画をアップロードしてください。" }, { status: 400 });
  }

  let videoUrl: string;
  try {
    videoUrl = await createStudioUploadSignedUrl(user.id, storagePath, SIGNED_URL_EXPIRES_S);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  const probed = await probeUpscaleVideo(videoUrl);
  // 測れなかったときは画面がブラウザの目安のまま表示を続ける（エラーにはしない）。
  return NextResponse.json({ success: true, meta: probed });
}
