import { NextResponse } from "next/server";
import { debitCredits, refundCredits } from "@/lib/credits.server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getOrCreateProfile } from "@/lib/profile";
import { dispatchAngleJob, type AngleDispatchSpec } from "@/lib/angleDispatch.server";
import { advanceQueue, saveDispatchSpec } from "@/lib/studioQueue.server";
import { getPricingKnobs } from "@/lib/pricing/knobs.server";
import { angleMaxAllowedTime } from "@/lib/pricing/costGuard.server";
import { downloadStudioUpload, deleteStudioUploads } from "@/lib/studioUploads.server";
import { SceneTranslateError, translateSceneInstructions } from "@/lib/sceneInstructionTranslate.server";
import {
  angleComboSubRefIndexes,
  angleCreditsPerAngle,
  type SubRefScope,
  anglePriorityParallelSurcharge,
  buildAngleCombos,
  MAX_ANGLES,
  MAX_SUB_REFERENCE_IMAGES,
  MIN_ANGLES,
  AZIMUTH_OPTIONS,
  ELEVATION_OPTIONS,
  DISTANCE_OPTIONS,
  type AngleSelection,
  type AngleSize,
  ANGLE_SMALL_MEGAPIXELS,
  isAngleSize,
} from "@/lib/angleStudio";

// Fully async now: this route only debits credits, inserts an angle_jobs row
// and fires the Modal dispatch (which .spawn()s the GPU job and ACKs in well
// under a second). It never waits on a generation, so a short budget is fine.
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
// メイン参照 + サブ参照（死角補完）。Multi-Angle Studio Pro。
const MAX_REF_IMAGES = 1 + MAX_SUB_REFERENCE_IMAGES;

function decodeBase64Image(raw: unknown): Buffer {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return Buffer.alloc(0);
  const b64 = s.startsWith("data:") ? s.slice(s.indexOf(",") + 1) : s;
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

// 「このジョブに許容できる最大 GPU 稼働時間（秒）」は消費クレジットから
// angleMaxAllowedTime() が算出し（式: 消費C × angle_time_per_credit_s +
// angle_cold_start_grace_s、いずれも admin 編集可能な pricing_knobs）、Modal
// ワーカーの原価割れウォッチドッグ（損切り自爆）へ max_allowed_time として渡す。

const VALID_IDS: Record<keyof AngleSelection, Set<string>> = {
  azimuths: new Set(AZIMUTH_OPTIONS.map((o) => o.id)),
  elevations: new Set(ELEVATION_OPTIONS.map((o) => o.id)),
  distances: new Set(DISTANCE_OPTIONS.map((o) => o.id)),
};

// 素材づくりの残りを 1 本で送る（SCENE_REST_BATCH_SIZE = SCENE_MAX_COUNT = 100、2026-10-03）。
const MAX_SCENES_PER_JOB = 100;
const MAX_SCENE_INSTRUCTION_CHARS = 500;
const MAX_SCENE_LABEL_CHARS = 120;

const MAX_IMAGE_SETS = 16;

/** 行ごとの画像セット（index のリストのリスト）。未指定は []、不正は null。 */
function sanitizeImageSets(raw: unknown, imageCount: number): number[][] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGE_SETS) return null;
  const out: number[][] = [];
  for (const st of raw) {
    if (!Array.isArray(st) || st.length === 0 || st.length > MAX_REF_IMAGES) return null;
    const idxs: number[] = [];
    for (const v of st) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= imageCount) return null;
      idxs.push(v);
    }
    out.push(idxs);
  }
  return out;
}

/** 素材づくりの文章指示。配列でなければ null（不正）、空配列は「未指定」として [] を返す。 */
function sanitizeScenes(raw: unknown): { instruction: string; label: string; set?: number }[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_SCENES_PER_JOB) return null;
  const out: { instruction: string; label: string; set?: number }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const o = item as Record<string, unknown>;
    // 制御文字を落とし、長さを抑える（プロンプト注入というより、長文でモデルを壊さないため）。
    const instruction = String(o.instruction ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SCENE_INSTRUCTION_CHARS);
    if (!instruction) return null;
    const label = String(o.label ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_SCENE_LABEL_CHARS);
    const set = typeof o.set === "number" && Number.isInteger(o.set) && o.set >= 0 ? o.set : undefined;
    out.push({ instruction, label, ...(set !== undefined ? { set } : {}) });
  }
  return out;
}

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
  // imageBuffers[0] = メイン参照（正面等）。以降 = サブ参照（背面ラフ・衣装
  // パーツ等、死角補完用、最大 MAX_SUB_REFERENCE_IMAGES 枚）。
  let imageBuffers: Buffer[] = [];
  let modeRaw: unknown;
  let selectionRaw: unknown;
  let seedRaw: unknown;
  let priorityRaw: unknown;
  // 素材づくり（2026-09-27）: ポーズ・場面の文章指示。あれば selection の代わりに使う。
  let scenesRaw: unknown;
  // 行ごとの画像セット（2026-09-28）: storagePaths/images の index のリスト。scenes[i].set がセットの index。
  let imageSetsRaw: unknown;
  // マルチアングル（2026-09-29）: サブ参照ごとの使い道（storagePaths[1..] と同じ並び）。
  // subRefScopes（"sides"|"noback"|"all"）。旧 subRefAll（true＝全構図）も受ける。
  let subRefAllRaw: unknown;
  let subRefScopesRaw: unknown;
  // 出力の縦横（2026-09-29）: "portrait" なら 832×1248（~1MP、料金・時間は従来どおり）。顔アップ→全身の候補用。
  let aspectRaw: unknown;
  let sizeRaw: unknown;
  // ネガティブプロンプト（2026-09-30、素材づくり）。制御文字を落として 600 文字まで。
  let negativeRaw: unknown;
  // 予約（2026-10-03）: true なら課金してジョブ行を reserved で作り、順番が来たらサーバーが起動する
  // （lib/studioQueue.server.ts）。画像は置き場所（storagePaths）で受けたときだけ・起動まで消さない。
  let queue = false;
  let storagePaths: string[] = [];

  if (contentType.includes("application/json")) {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
    }
    // `storagePaths: string[]`（メイン + サブ、先頭がメイン）— Supabase
    // Storage への直アップロード方式（本線経路。CLAUDE.md §6）。
    const storagePathsArr = Array.isArray(body.storagePaths)
      ? body.storagePaths.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    queue = body.queue === true;
    if (queue && storagePathsArr.length === 0) {
      return NextResponse.json({ error: "予約には画像のアップロードが必要です。" }, { status: 400 });
    }
    storagePaths = storagePathsArr;
    if (storagePathsArr.length > 0) {
      const downloaded: Buffer[] = [];
      for (const p of storagePathsArr) {
        try {
          downloaded.push(await downloadStudioUpload(user.id, p));
        } catch (err) {
          return NextResponse.json({ error: (err as Error).message }, { status: 400 });
        }
      }
      imageBuffers = downloaded;
      // ベストエフォート削除（読み終わったら不要）。予約は起動するまで残す。
      if (!queue) deleteStudioUploads(storagePathsArr);
    } else {
      // `images: string[]`（メイン + サブ、先頭がメイン）があれば優先。
      // 無ければ `image` + `subImages: string[]`。互換のため base64 も残す。
      const imagesArr = Array.isArray(body.images) ? (body.images as unknown[]) : null;
      if (imagesArr && imagesArr.length > 0) {
        imageBuffers = imagesArr.map(decodeBase64Image);
      } else {
        const subs = Array.isArray(body.subImages) ? (body.subImages as unknown[]) : [];
        imageBuffers = [decodeBase64Image(body.image), ...subs.map(decodeBase64Image)];
      }
    }
    modeRaw = body.mode;
    selectionRaw =
      typeof body.selection === "string" ? body.selection : JSON.stringify(body.selection ?? {});
    seedRaw = body.seed;
    priorityRaw = body.priority;
    scenesRaw = body.scenes;
    imageSetsRaw = body.imageSets;
    subRefAllRaw = body.subRefAll;
    subRefScopesRaw = body.subRefScopes;
    aspectRaw = body.aspect;
    sizeRaw = body.size;
    negativeRaw = body.negativePrompt;
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
    const subFiles = formData
      .getAll("subImage")
      .filter((f): f is File => f instanceof File && f.size > 0);
    const files = [imageFile, ...subFiles];
    imageBuffers = await Promise.all(files.map(async (f) => Buffer.from(await f.arrayBuffer())));
    modeRaw = formData.get("mode");
    selectionRaw = formData.get("selection");
    seedRaw = formData.get("seed");
    priorityRaw = formData.get("priority");
  }
  // 予約は並列の追加料金を取らない（順番待ち）。
  const priority = !queue && (priorityRaw === true || priorityRaw === "true");

  // 空要素（サブスロット未使用など）を落とし、先頭がメイン参照であることを保つ。
  imageBuffers = imageBuffers.filter((b) => b.length > 0);
  if (imageBuffers.length === 0) {
    return NextResponse.json({ error: "キャラクター画像をアップロードしてください。" }, { status: 400 });
  }
  // 行ごとの画像セットのときは、元画像の種類ぶん（メイン・切り出し 2・参照 3 など）まで受ける。
  const imageSets = sanitizeImageSets(imageSetsRaw, imageBuffers.length);
  if (imageSetsRaw !== undefined && imageSetsRaw !== null && imageSets === null) {
    return NextResponse.json({ error: "画像セットの指定が不正です。" }, { status: 400 });
  }
  const maxImages = imageSets && imageSets.length > 0 ? MAX_REF_IMAGES * 2 : MAX_REF_IMAGES;
  if (imageBuffers.length > maxImages) {
    return NextResponse.json(
      { error: `参照画像はメイン1枚＋サブ最大${MAX_SUB_REFERENCE_IMAGES}枚までです。` },
      { status: 400 },
    );
  }
  if (imageBuffers.some((b) => b.length > MAX_IMAGE_BYTES)) {
    return NextResponse.json(
      { error: "画像サイズが大きすぎます。1枚あたり 12MB 以下にしてください。" },
      { status: 400 },
    );
  }

  // 2026-09-09: 単一モードに統一。旧 "turbo"/"pro" payload も "standard" に丸める。
  void modeRaw;
  const mode = "standard" as const;

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

  // 素材づくり: 文章指示をサーバー側で検査してそのまま使う（角度 LoRA のトリガーは付けない）。
  // 1 ジョブは 8 枚ずつに分けて投げる設計なので最低枚数の制限は掛けない（起動待ちの償却は連続実行で成り立つ）。
  const scenes = sanitizeScenes(scenesRaw);
  if (scenesRaw !== undefined && scenesRaw !== null && scenes === null) {
    return NextResponse.json({ error: "ポーズ・場面の指定が不正です。" }, { status: 400 });
  }
  const rawPrompt = Boolean(scenes && scenes.length > 0);
  // 行ごとのセット index（無ければ全行 0 番＝全画像）。
  const sceneSets = rawPrompt && imageSets !== null && imageSets.length > 0;
  const sceneInstructionSets = sceneSets
    ? scenes!.map((sc) => (typeof sc.set === "number" && sc.set >= 0 && sc.set < imageSets!.length ? sc.set : 0))
    : null;
  // 素材づくりの自由入力（場面・ポーズ・服装・追加指示）は日本語で書ける。指示の中の日本語の語句を Gemini で
  // 英訳してからワーカーへ（2026-10-03、sceneInstructionTranslate.server.ts）。訳せなければ課金前にエラーで止める
  // （日本語のまま送ると指定が黙って無視され、料金だけかかる。ジョブ 5834d0ca でピースが 1 枚も出なかった）。
  if (rawPrompt) {
    try {
      const translated = await translateSceneInstructions(
        scenes!.map((sc) => sc.instruction),
        user.id,
      );
      scenes!.forEach((sc, i) => (sc.instruction = translated[i]));
    } catch (err) {
      if (!(err instanceof SceneTranslateError)) throw err;
      console.error("[studio/angle/generate] scene translate failed:", err.phrases);
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
  }
  const combos = rawPrompt
    ? scenes!.map((sc) => ({ instruction: sc.instruction, labelJa: sc.label }))
    : buildAngleCombos(selection);
  if (combos.length === 0) {
    return NextResponse.json({ error: "構図を1つ以上選択してください。" }, { status: 400 });
  }
  if (!rawPrompt && combos.length < MIN_ANGLES) {
    return NextResponse.json(
      { error: `1回のジョブは最低 ${MIN_ANGLES} 構図から生成できます。` },
      { status: 400 },
    );
  }
  if (combos.length > MAX_ANGLES) {
    return NextResponse.json(
      { error: `1回のジョブで生成できる構図は最大 ${MAX_ANGLES} 個です。選択を減らしてください。` },
      { status: 400 },
    );
  }
  // マルチアングルの参照の使い分け（2026-09-29）: サブ参照があれば、構図ごとに「メイン＋その構図で使うサブ」
  // （使い道 SubRefScope で決まる）のセットを組む。同じ組み合わせは 1 セットにまとめる。料金も構図ごと
  // （angleCombosCredits と同じ）。
  const angleSets = !rawPrompt && imageBuffers.length > 1;
  const subCountForScopes = Math.max(0, imageBuffers.length - 1);
  const scopesFromBody: SubRefScope[] = Array.from({ length: subCountForScopes }, (_, i) => {
    const v = Array.isArray(subRefScopesRaw) ? subRefScopesRaw[i] : undefined;
    if (v === "sides" || v === "noback" || v === "all") return v;
    return Array.isArray(subRefAllRaw) && subRefAllRaw[i] === true ? "all" : "sides";
  });
  let jobImageSets: number[][] | null = sceneSets ? imageSets! : null;
  let instructionSets: number[] | null = sceneSets ? sceneInstructionSets : null;
  if (angleSets) {
    const setKeys = new Map<string, number>();
    const sets: number[][] = [];
    instructionSets = buildAngleCombos(selection).map((c) => {
      const idx = [0, ...angleComboSubRefIndexes(c, scopesFromBody).map((i) => i + 1)];
      const key = idx.join(",");
      let k = setKeys.get(key);
      if (k === undefined) {
        k = sets.length;
        sets.push(idx);
        setKeys.set(key, k);
      }
      return k;
    });
    jobImageSets = sets;
  }
  const useSets = jobImageSets !== null && instructionSets !== null;
  // Multi-Reference: サブ参照ありは 1 構図あたりの生成時間が伸びる（B300 実測
  // ~3.0x @ サブ3枚）。構図数の上限は設けず（原価の歯止めは枚数連動の課金 +
  // ジョブ単位にスケールする Modal timeout + ワーカーの二重ウォッチドッグ）、
  // 課金 C からの max_allowed_time にそのぶんを反映させる。
  const subImageCount = imageBuffers.length - 1;

  const seedNum =
    typeof seedRaw === "number"
      ? seedRaw
      : typeof seedRaw === "string" && seedRaw.trim()
        ? Number(seedRaw)
        : NaN;
  const seed = Number.isFinite(seedNum) ? Math.trunc(seedNum) : null;

  // Server-side price — never trusted from the client.
  // サブ参照ぶんの生成コスト増（B300 実測 ~3.0x @ サブ3枚）を単価へ反映。
  const knobs = await getPricingKnobs();
  const size: AngleSize = isAngleSize(sizeRaw) ? sizeRaw : "large";
  // 行ごとのセットなら、行ごとの参照枚数（セットの枚数 − 1）で単価を出して合計する。
  const baseCost = useSets
    ? instructionSets!.reduce((t, si) => t + angleCreditsPerAngle(knobs, Math.max(0, jobImageSets![si].length - 1), size), 0)
    : combos.length * angleCreditsPerAngle(knobs, subImageCount, size);
  // 「実行中でも並列で今すぐ実行」を選んだ場合の上乗せ（順番待ち=無料の既定に
  // 対するオプトイン。通常料金 × 率 + 固定分。フロントと同じ関数・同じ baseCost）。
  const generationCost = priority ? baseCost + anglePriorityParallelSurcharge(knobs, baseCost) : baseCost;
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

  // クレジットはその場で引く（確かめるのと引くのを 1 回の操作に。同時に送られても 1 本分の料金で何本も作れない・2026-10-09）。
  let debitedCredits: number;
  try {
    const after = await debitCredits(user.id, generationCost);
    if (after === null) {
      return NextResponse.json(
        { error: "クレジットが不足しています。チャージしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 402 },
      );
    }
    debitedCredits = after;
  } catch (err) {
    console.error("[studio/angle/generate] failed to debit credits:", err);
    return NextResponse.json({ error: "クレジットの処理に失敗しました。" }, { status: 500 });
  }

  // --- job row ---------------------------------------------------------
  const { data: jobRow, error: jobError } = await supabaseAdmin
    .from("angle_jobs")
    .insert({
      user_id: user.id,
      status: queue ? "reserved" : "pending",
      mode,
      total_angles: combos.length,
      completed_angles: 0,
      images: [],
      labels: combos.map((c) => c.labelJa),
      credits_cost: generationCost,
      // Multi-Reference のデバッグ用（既存 jsonb 列・マイグレーション不要）。
      // worker が生成中に vram_used_gb を書き込むので、それとマージされる。
      metadata: {
        ref_image_count: useSets ? Math.max(...jobImageSets!.map((s) => s.length)) : imageBuffers.length,
        priority,
        ...(size === "small" ? { size } : {}),
        ...(rawPrompt ? { kind: "scene" } : {}),
        ...(useSets ? { image_sets: jobImageSets!.length } : {}),
      },
    })
    .select("id")
    .single();

  if (jobError || !jobRow) {
    console.error("[studio/angle/generate] failed to create job row:", jobError?.message);
    await refundCredits(user.id, generationCost);
    return NextResponse.json(
      { error: "ジョブの作成に失敗しました。", remainingCredits: currentCredits },
      { status: 500 },
    );
  }
  const jobId = jobRow.id as string;

  const spec: AngleDispatchSpec = {
    storagePaths: queue ? storagePaths : [],
    creditsCost: generationCost,
    maxAllowedTime,
    instructions: combos.map((c) => c.instruction),
    labels: combos.map((c) => c.labelJa),
    mode,
    seed,
    rawPrompt,
    ...(useSets ? { imageSets: jobImageSets!, instructionSets: instructionSets! } : {}),
    ...(aspectRaw === "portrait" ? { outputSize: { width: 832, height: 1248 } } : {}),
    ...(size === "small" ? { targetMegapixels: ANGLE_SMALL_MEGAPIXELS } : {}),
    ...(typeof negativeRaw === "string" && negativeRaw.trim()
      ? { negativePrompt: negativeRaw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 600) }
      : {}),
  };

  // --- 予約: 起動の引数を残して、順番が来ていればその場で起動 ----------------
  if (queue) {
    try {
      await saveDispatchSpec("angle", jobId, user.id, spec);
    } catch (err) {
      console.error("[studio/angle/generate] save spec failed:", (err as Error).message);
      await supabaseAdmin.from("angle_jobs").delete().eq("id", jobId);
      await refundCredits(user.id, generationCost);
      return NextResponse.json(
        { error: "予約に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
        { status: 500 },
      );
    }
    const started = await advanceQueue("angle", user.id);
    return NextResponse.json({
      success: true,
      jobId,
      reserved: started !== jobId,
      totalAngles: combos.length,
      remainingCredits: debitedCredits,
    });
  }

  // --- dispatch to Modal ---------------------------------------------
  try {
    await dispatchAngleJob(
      jobId,
      user.id,
      spec,
      imageBuffers.map((b) => b.toString("base64")),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[studio/angle/generate] dispatch failed:", message);
    await supabaseAdmin
      .from("angle_jobs")
      .update({ status: "failed", error_message: `ジョブの起動に失敗しました: ${message}`.slice(0, 500) })
      .eq("id", jobId);
    await refundCredits(user.id, generationCost);
    return NextResponse.json(
      { error: "生成ジョブの起動に失敗しました。しばらくしてから再度お試しください。", remainingCredits: currentCredits },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    jobId,
    reserved: false,
    totalAngles: combos.length,
    remainingCredits: debitedCredits,
  });
}
