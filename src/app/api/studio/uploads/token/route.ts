import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createStudioUploadTicket } from "@/lib/studioUploadTicket.server";

// Studio共通の一時アップロード（Director・Multi-Angle・超解像・特化ワーク
// フロー）用の署名付きアップロードチケットを発行する（2026-09-19導入）。
// 2026-09-23 からは既定で R2 への署名付き PUT URL（store: "r2"）を返し、
// ブラウザはそこへ直接ファイルを送る。UPLOAD_STORE=volume のときは従来の
// modal_studio_uploads.py::upload への POST チケット（store: "modal"）。
// どちらも Vercel のリクエストボディ上限も Supabase の月間送信量クォータも
// 経由しない。
export const maxDuration = 15;

export async function POST(request: Request) {
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

  let body: { filename?: unknown; sizeBytes?: unknown } = {};
  try {
    body = (await request.json()) as { filename?: unknown; sizeBytes?: unknown };
  } catch {
    // filename 必須なので下の型チェックで弾かれる。
  }
  const filename = typeof body.filename === "string" ? body.filename : "";
  if (!filename) {
    return NextResponse.json({ error: "filename が必要です。" }, { status: 400 });
  }
  const sizeBytes = typeof body.sizeBytes === "number" && Number.isFinite(body.sizeBytes) ? body.sizeBytes : undefined;
  // 2026-09-23 の切替前に読み込まれたタブ（古い JS バンドル）は sizeBytes を
  // 送ってこない。そのクライアントは R2 の URL に Modal 方式の POST を投げて
  // CORS プリフライト（POST は不許可）で「Failed to fetch」になるので、
  // 古いクライアントには従来の Modal チケットを返す。再読み込みで新経路になる。
  const legacyClient = !("sizeBytes" in body);

  try {
    const ticket = await createStudioUploadTicket(userData.user.id, filename, { sizeBytes, forceModal: legacyClient });
    return NextResponse.json(ticket);
  } catch (err) {
    console.error("[studio/uploads/token] failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
