import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { buildCinematicWorkflow } from "@/lib/cinematicWorkflow";
import { spawnCinematicVideoJob } from "@/lib/modalCinematic";
import { startActiveJob, endActiveJob } from "@/lib/activeGenerationJobs";
import { CINEMATIC_MODE_BY_ID, isCinematicModeId } from "@/lib/cinematicPricing";

// This route only debits credits, inserts a generation_jobs row, and fires
// a fast dispatch request at Modal (see spawnCinematicVideoJob) — the
// actual multi-minute render happens entirely inside a spawned Modal
// container, off this request's lifetime. maxDuration only needs to cover
// that dispatch + a couple of quick DB writes; the old value here (600s,
// to cover the *render itself*) was exactly the kind of Cloudflare/Vercel
// edge-timeout exposure this async conversion exists to eliminate.
export const maxDuration = 30;

async function fileToBase64(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  return buf.toString("base64");
}

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

  const user = userData.user;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const image = formData.get("image");
  const modeRaw = formData.get("mode");
  const prompt = formData.get("prompt");

  if (!(image instanceof File) || image.size === 0) {
    return NextResponse.json({ error: "画像をアップロードしてください。" }, { status: 400 });
  }
  if (!isCinematicModeId(modeRaw)) {
    return NextResponse.json({ error: "画質モードの指定が不正です。" }, { status: 400 });
  }

  // credits/steps/LoRA-usage always come from the fixed server-side catalog
  // by mode id — never trusted from the client, same posture as
  // wan-animate/generate's pricing lookups.
  const mode = CINEMATIC_MODE_BY_ID[modeRaw];
  const generationCost = mode.credits;

  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );

  if (profileError) {
    console.error("[generate/cinematic] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : (rawCredits ?? 0);

  if (isExpired && (rawCredits ?? 0) > 0) {
    const { error: expireError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: 0 })
      .eq("id", user.id);
    if (expireError) {
      console.error("[generate/cinematic] failed to apply credit expiry reset:", expireError.message);
    }
  }

  if (currentCredits < generationCost) {
    return NextResponse.json(
      {
        error: isExpired
          ? "クレジットの有効期限が切れています。チャージしてから再度お試しください。"
          : "クレジットが不足しています。チャージしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 402 },
    );
  }

  // Deducted up front (refunded below on failure) so two concurrent
  // requests can't both pass the balance check and overdraw the account.
  const debitedCredits = currentCredits - generationCost;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);

  if (debitError) {
    console.error("[generate/cinematic] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  const promptText = typeof prompt === "string" ? prompt : "";
  // No standard/ultra split on this pipeline (single Blackwell/B300
  // deployment) — logged as "ultra" for the admin GPU task manager, the
  // closest existing tier semantically (it *is* the B300-class tier).
  // Left open until modal_wan_animate_blackwell.py's spawned job actually
  // finishes and clears it directly (see run_custom_workflow's
  // _clear_active_job) — this request returns long before that happens.
  const activeJobId = await startActiveJob(user.id, `cinematic:${mode.id}`, "ultra");

  const { data: jobRow, error: jobInsertError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: "queued",
      workflow_type: "cinematic",
      inputs: { mode: mode.id, prompt: promptText },
      credits_cost: generationCost,
    })
    .select("id")
    .single();

  if (jobInsertError || !jobRow) {
    console.error("[generate/cinematic] failed to create job row:", jobInsertError?.message);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    await endActiveJob(activeJobId);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }

  const jobId = jobRow.id as string;

  try {
    const referenceImageName = `reference_${Date.now()}.png`;
    const referenceImageB64 = await fileToBase64(image);

    const workflow = buildCinematicWorkflow({
      mode,
      prompt: promptText,
      referenceImageName,
    });

    // Fire-and-forget from this request's point of view: this only waits
    // on Modal's near-instant dispatch ack (see spawnCinematicVideoJob),
    // not the render itself. The spawned job reports its own completion/
    // failure straight to generation_jobs and active_generation_jobs from
    // the Modal side (see modal_wan_animate_blackwell.py) — this route has
    // no more say in the outcome once this call returns successfully.
    await spawnCinematicVideoJob({
      jobId,
      userId: user.id,
      creditsCost: generationCost,
      activeJobId,
      workflow,
      referenceImageName,
      referenceImageB64,
    });

    return NextResponse.json({
      success: true,
      jobId,
      remainingCredits: debitedCredits,
    });
  } catch (err) {
    // The dispatch itself failed (Modal unreachable/rejected the request)
    // — the spawned job never started, so nothing on the Modal side will
    // ever report failure for it. This request is still live, so it's the
    // one responsible for unwinding the debit/job/active-job bookkeeping.
    console.error("[generate/cinematic] failed to dispatch job:", err);

    await supabaseAdmin
      .from("generation_jobs")
      .update({
        status: "failed",
        error_message: "ジョブの起動に失敗しました。",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    const { error: refundError } = await supabaseAdmin
      .from("profiles")
      .update({ credits: currentCredits })
      .eq("id", user.id);
    if (refundError) {
      console.error("[generate/cinematic] failed to refund credits after dispatch error:", refundError.message);
    }

    await endActiveJob(activeJobId);

    return NextResponse.json(
      {
        error: "動画生成の開始に失敗しました。しばらくしてから再度お試しください。",
        remainingCredits: currentCredits,
      },
      { status: 502 },
    );
  }
}
