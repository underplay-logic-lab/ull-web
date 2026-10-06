import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createStudioUploadSignedUrl } from "@/lib/studioUploads.server";
import { isDirectorRefRole, type DirectorRefRole } from "@/lib/directorPricing";

// Photo Director の「このプロンプトを編集して作り直す」（2026-10-06）: 元のジョブで使った人物の写真と参照写真を
// 画面の欄へ読み戻すための短命 URL を返す。読み戻した写真は普通の入力と同じ扱い（外す・役目を変える・足す）で、
// 送るときに改めてアップロードされる。アップロードは成功後も消していない（14 日で自動削除）ので、古いジョブは 404。

type RouteParams = { params: Promise<{ id: string }> };

const URL_TTL_S = 10 * 60;

export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  const { data: userData, error: userError } = await createClient(supabaseUrl, anonKey).auth.getUser(accessToken);
  if (userError || !userData?.user) return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  const userId = userData.user.id;

  const { data: job } = await supabaseAdmin
    .from("generation_jobs")
    .select("inputs")
    .eq("id", id)
    .eq("user_id", userId)
    .eq("workflow_type", "director")
    .maybeSingle();
  const inputs = (job?.inputs ?? null) as Record<string, unknown> | null;
  const mainPath = typeof inputs?.reference_storage_path === "string" ? inputs.reference_storage_path : "";
  if (!inputs || !mainPath) return NextResponse.json({ error: "元の写真が見つかりませんでした。" }, { status: 404 });

  const extraPaths = Array.isArray(inputs.extra_ref_paths)
    ? inputs.extra_ref_paths.filter((p): p is string => typeof p === "string")
    : [];
  const extraRoles = Array.isArray(inputs.extra_ref_roles) ? inputs.extra_ref_roles : [];

  try {
    const [main, ...refs] = await Promise.all(
      [mainPath, ...extraPaths].map((p) => createStudioUploadSignedUrl(userId, p, URL_TTL_S)),
    );
    return NextResponse.json({
      main: { url: main, name: mainPath.split("/").pop() ?? "photo.png" },
      refs: refs.map((url, i) => ({
        url,
        name: extraPaths[i].split("/").pop() ?? `ref_${i + 1}.png`,
        role: (isDirectorRefRole(extraRoles[i]) ? extraRoles[i] : "person") as DirectorRefRole,
      })),
    });
  } catch (err) {
    console.error("[director/photo-refs] sign failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "元の写真が見つかりませんでした。" }, { status: 404 });
  }
}
