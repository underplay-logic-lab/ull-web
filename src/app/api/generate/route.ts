import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { generateImageWithRunpod } from "@/lib/runpod";
import { aspectRatios, type AspectRatio } from "@/lib/data";

// GPU cold starts + ComfyUI inference can comfortably exceed the default
// serverless timeout, so give this route room to wait on RunPod.
export const maxDuration = 300;

const VALID_RATIOS = new Set<AspectRatio>(aspectRatios.map((r) => r.id));

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

  // Verify the caller's session server-side rather than trusting a
  // client-supplied user id.
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);

  if (userError || !userData?.user) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }

  const user = userData.user;

  let body: { prompt?: string; ratio?: AspectRatio };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "リクエストの形式が正しくありません。" },
      { status: 400 },
    );
  }

  const prompt = body.prompt?.trim();
  const ratio = body.ratio;

  if (!prompt) {
    return NextResponse.json({ error: "プロンプトを入力してください。" }, { status: 400 });
  }

  if (!ratio || !VALID_RATIOS.has(ratio)) {
    return NextResponse.json({ error: "アスペクト比が不正です。" }, { status: 400 });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("credits, credits_expire_at")
    .eq("id", user.id)
    .single();

  if (profileError) {
    console.error("[generate] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const isExpired = profile?.credits_expire_at
    ? new Date(profile.credits_expire_at).getTime() < Date.now()
    : false;
  const currentCredits = isExpired ? 0 : (profile?.credits ?? 0);

  if (currentCredits < 1) {
    return NextResponse.json(
      {
        error: isExpired
          ? "クレジットの有効期限が切れています（残高0）。チャージしてから再度お試しください。"
          : "クレジットが不足しています。チャージしてから再度お試しください。",
      },
      { status: 402 },
    );
  }

  let imageDataUrl: string;
  try {
    imageDataUrl = await generateImageWithRunpod(prompt, ratio);
  } catch (err) {
    console.error("[generate] RunPod generation failed:", err);
    return NextResponse.json(
      { error: "画像生成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 },
    );
  }

  const { error: updateError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: currentCredits - 1 })
    .eq("id", user.id);

  if (updateError) {
    // The image was already generated; surface it to the user even if the
    // credit deduction failed, but log loudly since balances will drift.
    console.error("[generate] failed to deduct credit:", updateError.message);
  }

  return NextResponse.json({
    image: imageDataUrl,
    credits: updateError ? currentCredits : currentCredits - 1,
  });
}
