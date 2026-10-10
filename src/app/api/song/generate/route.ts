import { NextResponse } from "next/server";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { songWarmSettle } from "@/lib/pricing/warmRefund";
import {
  SONG_IDEA_MAX_LENGTH,
  SONG_LYRICS_MAX_LENGTH,
  SONG_STYLE_MAX_LENGTH,
  SONG_VOICE_STYLE_MAX_LENGTH,
  clampSongCount,
  clampSongParts,
  songPartsFromLyrics,
  isSongVoiceId,
  songCredits,
  songPriorityParallelSurcharge,
  SONG_VOICES,
} from "@/lib/songPricing";
import { planSong, type SongPlan } from "@/lib/songPrompt";
import { DirectorPromptError } from "@/lib/directorPrompt";
import { dispatchSongJob, type SongDispatchSpec } from "@/lib/modalSong";
import { rememberGenerationCall } from "@/lib/modalCallRecord.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";
import { CONTENT_POLICY_BLOCK_MESSAGE, evaluateContentPolicyMany, logContentPolicyBlock } from "@/lib/contentPolicy";

// 曲づくり（2026-10-06）: 思いつき（または手書きの歌詞）→ Gemini が歌詞・曲調を整える → 課金 → Modal（L40S・ACE-Step XL SFT）で
// シード違いの曲を count 本。ジョブは generation_jobs（workflow_type "song"）。結果は /api/jobs/[id] が R2 の署名 URL で返す。
// 予約（順番待ち）は Director と同じサーバー側の仕組み（kind "song"、要 migration 20260896000000）。
export const maxDuration = 60;

export async function POST(request: Request) {
  const accessToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  const { data: userData, error: userError } = await createClient(supabaseUrl, anonKey).auth.getUser(accessToken);
  if (userError || !userData?.user) return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  const user = userData.user;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const mode = body.mode === "lyrics" ? "lyrics" : "idea";
  const idea = typeof body.idea === "string" ? body.idea.trim().slice(0, SONG_IDEA_MAX_LENGTH) : "";
  const lyricsIn = typeof body.lyrics === "string" ? body.lyrics.trim().slice(0, SONG_LYRICS_MAX_LENGTH) : "";
  const style = typeof body.style === "string" ? body.style.trim().slice(0, SONG_STYLE_MAX_LENGTH) : "";
  const voice = isSongVoiceId(body.voice) ? body.voice : "female";
  const voiceStyle = typeof body.voiceStyle === "string" ? body.voiceStyle.trim().slice(0, SONG_VOICE_STYLE_MAX_LENGTH) : "";
  const count = clampSongCount(body.count);
  // 長さ（何番まで）。手書きの歌詞は行数で決める（フロントの表示と同じ関数）。
  const parts = mode === "lyrics" ? songPartsFromLyrics(lyricsIn) : clampSongParts(body.parts);
  const queue = body.queue === true;
  const priority = !queue && body.priority === true;
  if (mode === "idea" && !idea) return NextResponse.json({ error: "どんな曲にしたいかを書いてください。" }, { status: 400 });
  if (mode === "lyrics" && !lyricsIn) return NextResponse.json({ error: "歌詞を入れてください。" }, { status: 400 });

  const policy = evaluateContentPolicyMany([idea, lyricsIn, style, voiceStyle].filter(Boolean));
  if (policy.blocked) {
    logContentPolicyBlock("song/generate", policy, user.id);
    return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  }

  const knobs = await getPricingKnobs();
  const baseCost = songCredits(count, parts, knobs);
  const creditsCost = priority ? baseCost + songPriorityParallelSurcharge(knobs, baseCost) : baseCost;

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

  // 歌詞・曲調を整える（課金前）。手書きの歌詞で断られたら、歌詞はそのまま・曲調は選んだ声と既定で作る（書いた本人の歌詞なので止めない）。
  let plan: SongPlan;
  try {
    plan = await planSong({ idea, lyrics: mode === "lyrics" ? lyricsIn : undefined, style, voice, voiceStyle, parts });
  } catch (err) {
    const e = err as DirectorPromptError;
    if (mode === "lyrics" && e.reason === "refusal") {
      const vt = SONG_VOICES.find((v) => v.id === voice)?.tag ?? SONG_VOICES[0].tag;
      plan = { title: "", lyrics: lyricsIn, tags: `J-pop, ${vt}, catchy chorus`, bpm: 120, keyscale: "C major", language: "ja" };
    } else if (e.reason === "refusal") {
      return NextResponse.json(
        {
          code: "song_refused",
          error: "この内容では歌詞を自動で作れませんでした。「歌詞を書く」に切り替えて、歌詞を直接入れてください。",
          remainingCredits: currentCredits,
        },
        { status: 409 },
      );
    } else {
      const status = e.reason === "quota" ? 429 : e.reason === "busy" ? 503 : e.reason === "not_configured" ? 501 : 502;
      return NextResponse.json({ error: e.message || "歌詞の作成に失敗しました。" }, { status });
    }
  }
  const planPolicy = evaluateContentPolicyMany([plan.lyrics, plan.tags]);
  if (planPolicy.blocked) {
    logContentPolicyBlock("song/generate:plan", planPolicy, user.id);
    return NextResponse.json({ error: CONTENT_POLICY_BLOCK_MESSAGE }, { status: 400 });
  }

  // クレジットはその場で引く（確かめるのと引くのを 1 回の操作に。同時に送られても 1 本分の料金で何本も作れない・2026-10-09）。
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
    console.error("[song/generate] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  const seed = 1 + Math.floor(Math.random() * 2 ** 31);
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("generation_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "queued",
      workflow_type: "song",
      credits_cost: creditsCost,
      inputs: { mode, idea: idea || null, style: style || null, voice, voiceStyle: voiceStyle || null, count, parts, seed, plan },
      metadata: { count, parts, priority },
    })
    .select("id")
    .single();
  if (jobError || !jobRow) {
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits }, { status: 500 });
  }
  const jobId = jobRow.id as string;
  const spec: SongDispatchSpec = {
    creditsCost,
    count,
    parts,
    seed,
    params: { tags: plan.tags, lyrics: plan.lyrics, bpm: plan.bpm, keyscale: plan.keyscale, language: plan.language },
    warmSettle: songWarmSettle(baseCost, knobs),
  };

  if (queue) {
    try {
      await saveDispatchSpec("song", jobId, user.id, spec);
    } catch (err) {
      console.error("[song/generate] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("generation_jobs").delete().eq("id", jobId);
      await refundCredits(user.id, creditsCost);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("song", user.id);
    return NextResponse.json({ jobId, reserved: started !== jobId, creditsCost, remainingCredits: debited, plan });
  }

  try {
    const { callId } = await dispatchSongJob(jobId, user.id, spec);
    await rememberGenerationCall(jobId, callId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[song/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("generation_jobs")
      .update({ status: "failed", error_message: message.slice(0, 2000), metadata: { count, refunded: true } })
      .eq("id", jobId);
    await refundCredits(user.id, creditsCost);
    return NextResponse.json({ error: "生成の開始に失敗しました。", remainingCredits: currentCredits }, { status: 502 });
  }
  return NextResponse.json({ jobId, reserved: false, creditsCost, remainingCredits: debited, plan });
}
