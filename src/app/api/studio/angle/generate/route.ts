import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { spawnAngleJob } from "@/lib/modalAngle";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { angleMaxAllowedTime } from "@/lib/pricing/costGuard.server";
import {
  angleCreditsPerAngle,
  buildAngleCombos,
  isAngleMode,
  MAX_ANGLES,
  AZIMUTH_OPTIONS,
  ELEVATION_OPTIONS,
  DISTANCE_OPTIONS,
  type AngleSelection,
} from "@/lib/angleStudio";

// Fully async now: this route only debits credits, inserts an angle_jobs row
// and fires the Modal dispatch (which .spawn()s the GPU job and ACKs in well
// under a second). It never waits on a generation, so a short budget is fine.
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

// 「このジョブに許容できる最大 GPU 稼働時間（秒）」は消費クレジットから
// angleMaxAllowedTime() が算出し（式: 消費C × angle_time_per_credit_s +
// angle_cold_start_grace_s、いずれも admin 編集可能な pricing_knobs）、Modal
// ワーカーの原価割れウォッチドッグ（損切り自爆）へ max_allowed_time として渡す。

const VALID_IDS: Record<keyof AngleSelection, Set<string>> = {
  azimuths: new Set(AZIMUTH_OPTIONS.map((o) => o.id)),
  elevations: new Set(ELEVATION_OPTIONS.map((o) => o.id)),
  distances: new Set(DISTANCE_OPTIONS.map((o) => o.id)),
};

function sanitizeSelection(raw: unknown): AngleSelection {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const pick = (axis: keyof AngleSelection): string[] => {
    const arr = Array.isArray(obj[axis]) ? (obj[axis] as unknown[]) : [];
    const seen = new Set<string>();
    for (const v of arr) {
      if (typeof v === "string" && VALID_IDS[axis].has(v)) seen.add(v);
    }
    return [...seen];
  };
  return {
    azimuths: pick("azimuths"),
    elevations: pick("elevations"),
    distances: pick("distances"),
  };
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

  // ── リクエストボディの取得 ─────────────────────────────────────────
  // multipart/form-data（既定・ブラウザからの通常経路）と application/json
  // + base64（フォールバック）の両方を受ける。生の高解像度画像をそのまま
  // multipart で送ると、デプロイ環境のリクエストボディ上限（Vercel は
  // 約 4.5MB）でボディが途中で打ち切られ、request.formData() が壊れて
  // 「リクエストの形式が正しくありません。」になる。クライアントは
  // normalizeAngleReferenceImage() で縮小してから送るが、外部呼び出しや
  // 縮小不能な入力に備えて JSON 経路も残す。構図数（8×4×3=最大 96）そのものは
  // どちらの経路でも一切制限しない。
  const contentType = request.headers.get("content-type") ?? "";
  let imageBytes: Buffer;
  let modeRaw: unknown;
  let selectionRaw: unknown;
  let seedRaw: unknown;

  if (contentType.includes("application/json")) {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
    }
    const imageStr = typeof body.image === "string" ? body.image.trim() : "";
    const b64 = imageStr.startsWith("data:") ? imageStr.slice(imageStr.indexOf(",") + 1) : imageStr;
    imageBytes = b64 ? Buffer.from(b64, "base64") : Buffer.alloc(0);
    modeRaw = body.mode;
    selectionRaw =
      typeof body.selection === "string" ? body.selection : JSON.stringify(body.selection ?? {});
    seedRaw = body.seed;
  } else {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        {
          error:
            "画像の受信に失敗しました。画像のファイルサイズが大きすぎる可能性があります。別の画像で再度お試しください。",
        },
        { status: 400 },
      );
    }
    const imageFile = formData.get("image");
    if (!(imageFile instanceof File) || imageFile.size === 0) {
      return NextResponse.json({ error: "キャラクター画像をアップロードしてください。" }, { status: 400 });
    }
    imageBytes = Buffer.from(await imageFile.arrayBuffer());
    modeRaw = formData.get("mode");
    selectionRaw = formData.get("selection");
    seedRaw = formData.get("seed");
  }

  if (imageBytes.length === 0) {
    return NextResponse.json({ error: "キャラクター画像をアップロードしてください。" }, { status: 400 });
  }
  if (imageBytes.length > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { error: "画像サイズが大きすぎます。12MB 以下にしてください。" },
      { status: 400 },
    );
  }

  const mode = isAngleMode(modeRaw) ? modeRaw : "turbo";

  let selection: AngleSelection = { azimuths: [], elevations: [], distances: [] };
  if (typeof selectionRaw === "string" && selectionRaw.trim()) {
    try {
      selection = sanitizeSelection(JSON.parse(selectionRaw));
    } catch {
      return NextResponse.json({ error: "構図の指定が不正です。" }, { status: 400 });
    }
  } else if (selectionRaw && typeof selectionRaw === "object") {
    selection = sanitizeSelection(selectionRaw);
  }

  const combos = buildAngleCombos(selection);
  if (combos.length === 0) {
    return NextResponse.json({ error: "構図を1つ以上選択してください。" }, { status: 400 });
  }
  if (combos.length > MAX_ANGLES) {
    return NextResponse.json(
      { error: `1回のジョブで生成できる構図は最大 ${MAX_ANGLES} 個です。選択を減らしてください。` },
      { status: 400 },
    );
  }

  const seedNum =
    typeof seedRaw === "number"
      ? seedRaw
      : typeof seedRaw === "string" && seedRaw.trim()
        ? Number(seedRaw)
        : NaN;
  const seed = Number.isFinite(seedNum) ? Math.trunc(seedNum) : null;

  // Server-side price — never trusted from the client.
  const knobs = await getPricingKnobs();
  const generationCost = combos.length * angleCreditsPerAngle(mode, knobs);
  const maxAllowedTime = angleMaxAllowedTime({ creditsCost: generationCost, knobs });

  const { data: profile, error: profileError } = await getOrCreateProfile(
    user.id,
    "credits, credits_expire_at",
  );
  if (profileError) {
    console.error("[studio/angle/generate] failed to load profile:", profileError.message);
    return NextResponse.json({ error: "プロフィールの取得に失敗しました。" }, { status: 500 });
  }

  const creditsExpireAt = profile?.credits_expire_at as string | null | undefined;
  const rawCredits = profile?.credits as number | null | undefined;
  const isExpired = creditsExpireAt ? new Date(creditsExpireAt).getTime() < Date.now() : false;
  const currentCredits = isExpired ? 0 : rawCredits ?? 0;

  if (isExpired && (rawCredits ?? 0) > 0) {
    await supabaseAdmin.from("profiles").update({ credits: 0 }).eq("id", user.id);
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

  const debitedCredits = currentCredits - generationCost;
  const { error: debitError } = await supabaseAdmin
    .from("profiles")
    .update({ credits: debitedCredits })
    .eq("id", user.id);
  if (debitError) {
    console.error("[studio/angle/generate] failed to debit credits:", debitError.message);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row ---------------------------------------------------------
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("angle_jobs")
    .insert({
      user_id: user.id,
      status: "pending",
      mode,
      total_angles: combos.length,
      completed_angles: 0,
      images: [],
      labels: combos.map((c) => c.labelJa),
      credits_cost: generationCost,
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("[studio/angle/generate] failed to create job row:", jobError?.message);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  // --- dispatch to Modal ---------------------------------------------
  try {
    const imageBase64 = imageBytes.toString("base64");
    await spawnAngleJob({
      jobId,
      userId: user.id,
      creditsCost: generationCost,
      maxAllowedTime,
      imageBase64,
      instructions: combos.map((c) => c.instruction),
      labels: combos.map((c) => c.labelJa),
      mode,
      seed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/angle/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("angle_jobs")
      .update({ status: "failed", error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500) })
      .eq("id", jobId);
    await supabaseAdmin.from("profiles").update({ credits: currentCredits }).eq("id", user.id);
    return NextResponse.json(
      { error: "生成ジョブの起動に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    jobId,
    totalAngles: combos.length,
    remainingCredits: debitedCredits,
  });
}
