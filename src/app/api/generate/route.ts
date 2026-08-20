import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { generateImageWithRunpod } from "@/lib/runpod";
import { translateToEnglish } from "@/lib/translate";
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

  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );

  if (profileError) {
    console.error("[generate] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt
    ? new Date(creditsExpireAt).getTime() < Date.now()
    : false;
  const currentCredits = isExpired ? 0 : (rawCredits ?? 0);

  // JIT (just-in-time) expiry: write the reset back to the DB now rather
  // than only treating the balance as 0 for this request's check, so the
  // stale credits don't linger and get miscounted by anything else that
  // reads profiles.credits directly (e.g. the header's balance display).
  if (isExpired && (rawCredits ?? 0) > 0) {
    const { error: expireError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: 0 })
      .eq("id", user.id);

    if (expireError) {
      console.error("[generate] failed to apply credit expiry reset:", expireError.message);
    }
  }

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

  // Deduct up front (rather than after a successful generation) so two
  // concurrent requests can't both pass the balance check above and
  // overdraw the account. If generation then fails, the credit is refunded
  // below — the user is never charged for a failed run.
  const debitedCredits = currentCredits - 1;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);

  if (debitError) {
    console.error("[generate] failed to debit credit:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  let imageDataUrl: string;
  try {
    // FLUX.1-dev is trained on English captions, so translate a Japanese
    // prompt before it's dropped into the ComfyUI workflow.
    const generationPrompt = await translateToEnglish(prompt);
    imageDataUrl = await generateImageWithRunpod(generationPrompt, ratio);
  } catch (err) {
    console.error("[generate] RunPod generation failed:", err);

    const { error: refundError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: currentCredits })
      .eq("id", user.id);

    if (refundError) {
      console.error("[generate] failed to refund credit after error:", refundError.message);
    }

    return NextResponse.json(
      { error: "画像生成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 },
    );
  }

  return NextResponse.json({ success: true, image: imageDataUrl, remainingCredits: debitedCredits });
}
