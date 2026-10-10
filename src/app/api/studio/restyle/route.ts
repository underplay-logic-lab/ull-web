import { NextResponse } from "next/server";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { restyleWarmSettle } from "@/lib/pricing/warmRefund";
import { requireFeature, userFromBearer } from "@/lib/features.server";
import { assertOwnedPath, readStudioUploadHead } from "@/lib/studioUploads.server";
import { readImageDimensions } from "@/lib/imageDimensions";
import {
  clampRestyleCount,
  isRestyleKeep,
  isRestyleStyle,
  restyleCredits,
  restyleOutputDims,
  restylePriorityParallelSurcharge,
  RESTYLE_FREE_STYLE_MAX,
} from "@/lib/restylePricing";
import { buildRestyleWorkflow } from "@/lib/restyleWorkflow";
import { dispatchDirectorJob, type DirectorDispatchSpec } from "@/lib/directorDispatch.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";

// 画風を変える（構図そのまま・2026-10-10・許可制 restyle_trial）: 元画像 1 枚＋画風＋形の残し方＋枚数 → 課金 → Modal
// （modal_wan_animate_blackwell.py の custom_workflow_async・image_outputs・RTX PRO 6000）。ワークフローは src/lib/restyleWorkflow.ts。
// ジョブは Photo Director と同じ generation_jobs の workflow_type "director"（予約の順番・返金・ログ・GPU・R2 を共用）で、inputs.output = "restyle"。
// 画像はブラウザが R2 へ直接上げ（studioUploads.ts）、ここには path だけが来る。結果は /api/jobs/[id] が R2 の署名 URL で返す。
export const maxDuration = 60;

const RESTYLE_GPU = "RTX-PRO-6000" as const;

export async function POST(request: Request) {
  const user = await userFromBearer(request);
  if (!user) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  const denied = await requireFeature(user, "restyle_trial");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const imagePath = typeof body.imagePath === "string" ? body.imagePath : "";
  if (!imagePath) return NextResponse.json({ error: "元の画像を入れてください。" }, { status: 400 });
  try {
    assertOwnedPath(user.id, imagePath);
  } catch {
    return NextResponse.json({ error: "不正なファイル指定です。" }, { status: 400 });
  }
  const style = isRestyleStyle(body.style) ? body.style : "anime";
  const freeStyle = typeof body.freeStyle === "string" ? body.freeStyle.trim().slice(0, RESTYLE_FREE_STYLE_MAX) : "";
  if (style === "free" && !freeStyle) return NextResponse.json({ error: "どんな画風にしたいかを書いてください。" }, { status: 400 });
  const keep = isRestyleKeep(body.keep) ? body.keep : "medium";
  const count = clampRestyleCount(body.count);

  // 元画像の縦横（先頭だけ読む）。読めない形式は 1:1 で描く。
  let dims = { width: 1024, height: 1024 };
  try {
    const { head } = await readStudioUploadHead(user.id, imagePath, 256 * 1024);
    const d = readImageDimensions(head);
    if (d && d.width > 0 && d.height > 0) dims = d;
  } catch (err) {
    return NextResponse.json({ error: `画像を読めませんでした: ${(err as Error).message}` }, { status: 400 });
  }
  const out = restyleOutputDims(dims.width, dims.height);

  const queue = body.queue === true;
  const priority = !queue && body.priority === true;
  const knobs = await getPricingKnobs();
  const baseCost = restyleCredits(count, knobs);
  const creditsCost = priority ? baseCost + restylePriorityParallelSurcharge(knobs, baseCost) : baseCost;

  const { data: profile, error: profileError } = await getOrCreateProfile(user.id, "credits, credits_expire_at");
  if (profileError) return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  const expireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = (profile?.credits as number | null | undefined) ?? 0;
  const isExpired = expireAt ? new Date(expireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : rawCredits;
  if (isExpired && rawCredits > 0) await supabaseAdmin.from("profiles").update({ credits: 0 }).eq("id", user.id);
  if (currentCredits < creditsCost) {
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

  // クレジットはその場で引く（確かめるのと引くのを 1 回の操作に、CLAUDE.md §3）。
  let debited: number;
  try {
    const after = await debitCredits(user.id, creditsCost);
    if (after === null) {
      return NextResponse.json(
        { error: "クレジットが不足しています。チャージしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 402 },
      );
    }
    debited = after;
  } catch (err) {
    console.error("[restyle] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  const seed = 1 + Math.floor(Math.random() * 2 ** 31);
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "queued",
      workflow_type: "director",
      credits_cost: creditsCost,
      inputs: {
        output: "restyle",
        reference_storage_path: imagePath,
        style,
        free_style: freeStyle || null,
        keep,
        count,
        seed,
        out_width: out.width,
        out_height: out.height,
      },
      metadata: { output: "restyle", count, priority, out_width: out.width, out_height: out.height },
    })
    .select("id")
    .single();
  if (jobError || !jobRow) {
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits }, { status: 500 });
  }
  const jobId = jobRow.id as string;
  const ext = (imagePath.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const referenceImageName = `restyle_${jobId}.${ext}`;
  const spec: DirectorDispatchSpec = {
    storagePath: imagePath,
    referenceImageName,
    creditsCost,
    warmSettle: restyleWarmSettle(baseCost, knobs),
    workflow: buildRestyleWorkflow({
      imageName: referenceImageName,
      width: out.width,
      height: out.height,
      style,
      freeStyle,
      keep,
      count,
      seed,
      prefix: `restyle_${jobId}`,
    }),
    imageOutputs: true,
    gpu: RESTYLE_GPU,
    // 待ち上限は多めに（CLAUDE.md §0）: 起動込み 約 3 分＋1 枚 約 1.5 分の見込みの 2 倍以上。
    pollDeadlineS: 900 + 180 * count,
  };

  if (queue) {
    try {
      await saveDispatchSpec("director", jobId, user.id, JSON.parse(JSON.stringify(spec)));
    } catch (err) {
      console.error("[restyle] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("generation_jobs").delete().eq("id", jobId);
      await refundCredits(user.id, creditsCost);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("director", user.id);
    return NextResponse.json({ jobId, reserved: started !== jobId, creditsCost, remainingCredits: debited });
  }

  try {
    await dispatchDirectorJob(jobId, user.id, spec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[restyle] dispatch failed:", message);
    await supabaseAdmin
      .from("generation_jobs")
      .update({ status: "failed", error_message: message.slice(0, 2000), metadata: { output: "restyle", count, refunded: true } })
      .eq("id", jobId);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "生成の開始に失敗しました。", remainingCredits: currentCredits }, { status: 502 });
  }
  return NextResponse.json({ jobId, reserved: false, creditsCost, remainingCredits: debited });
}
