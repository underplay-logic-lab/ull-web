import crypto from "crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { presignPublishedArtifact } from "@/lib/r2.server";

// admin「生成物 & ストレージ」— 最近の生成物ビュー。
// angle_jobs / upscale_jobs / generation_jobs を横断し、共通形に正規化して
// 新しい順に返す。各テーブルから PER_TABLE 件ずつ取ってマージ・カット。

const PER_TABLE = 60;
const RETURN_LIMIT = 100;

// 2026-09-18〜: Director/超解像(画像・動画)/Multi-Angleの結果はSupabase
// Storageの公開URLではなく、Volume相対パスをDBに保存するようになった
// （CLAUDE.md §1）。admin一覧の「開く」リンクもそのままでは404になるため、
// ここで各ワーカーの署名スキームに合わせてModal直リンクへ変換する。
// 既にこの一覧はrequireAdmin済み・行データも既にメモリ上にあるので、
// 追加のDBラウンドトリップ無しでHMAC計算だけで済む。
// 2026-09-23〜（R2 移行 計画 3）: worker の CPU publish が済んだ行は
// metadata.r2_keys に相対パスが入り、Volume 側の実体は消えている。先に
// presignPublishedArtifact()（R2 の署名付き GET）を試し、無ければ従来の Modal。
const RESULT_TOKEN_TTL_SECONDS = 900;

function isVolumePath(v: string): boolean {
  return !/^https?:\/\//i.test(v) && !v.startsWith("data:");
}

function signAngleImageUrl(userId: string, jobId: string, rawPath: string): string | null {
  const modalUrl = process.env.MODAL_ANGLE_IMAGE_DOWNLOAD_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  const filename = rawPath.split("/").pop() ?? "";
  if (!modalUrl || !authToken || !/^[0-9]{2}\.png$/.test(filename)) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + RESULT_TOKEN_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", authToken)
    .update(`${userId}:${jobId}:${filename}:${expiresAt}`)
    .digest("hex");
  const target = new URL(modalUrl);
  target.searchParams.set("user_id", userId);
  target.searchParams.set("job_id", jobId);
  target.searchParams.set("filename", filename);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);
  return target.toString();
}

function signUpscaleResultUrl(userId: string, jobId: string, rawPath: string): string | null {
  const isVideo = rawPath.startsWith("upscale_video_results/");
  const modalUrl = isVideo
    ? process.env.MODAL_SEEDVR2_VIDEO_RESULT_DOWNLOAD_URL
    : process.env.MODAL_SEEDVR2_IMAGE_RESULT_DOWNLOAD_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!modalUrl || !authToken) return null;
  const filename = isVideo ? `${jobId}.mp4` : (rawPath.split("/").pop() ?? "");
  const expiresAt = Math.floor(Date.now() / 1000) + RESULT_TOKEN_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", authToken)
    .update(`${userId}:${jobId}:${filename}:${expiresAt}`)
    .digest("hex");
  const target = new URL(modalUrl);
  target.searchParams.set("user_id", userId);
  target.searchParams.set("job_id", jobId);
  if (!isVideo) target.searchParams.set("filename", filename);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);
  return target.toString();
}

function signDirectorVideoUrl(userId: string, jobId: string): string | null {
  const modalUrl = process.env.MODAL_DIRECTOR_VIDEO_DOWNLOAD_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!modalUrl || !authToken) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + RESULT_TOKEN_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", authToken)
    .update(`director-video:${userId}:${jobId}:${expiresAt}`)
    .digest("hex");
  const target = new URL(modalUrl);
  target.searchParams.set("user_id", userId);
  target.searchParams.set("job_id", jobId);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);
  return target.toString();
}

function signCustomWorkflowResultUrl(userId: string, jobId: string, rawPath: string): string | null {
  const modalUrl = process.env.MODAL_CUSTOM_WORKFLOW_RESULT_DOWNLOAD_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  const filename = rawPath.split("/").pop() ?? "";
  if (!modalUrl || !authToken || !filename) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + RESULT_TOKEN_TTL_SECONDS;
  const sig = crypto
    .createHmac("sha256", authToken)
    .update(`${userId}:${jobId}:${filename}:${expiresAt}`)
    .digest("hex");
  const target = new URL(modalUrl);
  target.searchParams.set("user_id", userId);
  target.searchParams.set("job_id", jobId);
  target.searchParams.set("filename", filename);
  target.searchParams.set("expires", String(expiresAt));
  target.searchParams.set("sig", sig);
  return target.toString();
}

type GenRow = {
  id: string;
  kind: "angle" | "upscale" | "video" | "lora";
  label: string;
  userId: string;
  userEmail: string | null;
  status: string;
  creditsCost: number;
  thumbUrl: string | null;
  /** 追加リンク（複数枚 / .safetensors パス等）。 */
  extra: string | null;
  errorMessage: string | null;
  createdAt: string;
  /** kind:"upscale" のみ — WebP劣化前の元PNGがModal Volumeにある場合そのファイル名。 */
  originalFilename: string | null;
  /** kind:"upscale" のみ — まとめて処理のバッチ id（中止ボタンはバッチ単位で閉じる、2026-09-25）。 */
  batchId?: string | null;
};

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) {
    const s = v.find((x) => typeof x === "string" && x);
    return typeof s === "string" ? s : null;
  }
  return typeof v === "string" && v ? v : null;
}

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const [angle, upscale, gen] = await Promise.all([
    supabaseAdmin
      .from("angle_jobs")
      .select(
        "id, user_id, status, mode, total_angles, completed_angles, images, credits_cost, error_message, created_at, metadata",
      )
      .order("created_at", { ascending: false })
      .limit(PER_TABLE),
    supabaseAdmin
      .from("upscale_jobs")
      .select("id, user_id, status, model_key, preset, result_url, credits_cost, error_message, created_at, metadata, batch_id, batch_index, batch_total")
      .order("created_at", { ascending: false })
      .limit(PER_TABLE),
    supabaseAdmin
      .from("generation_jobs")
      // video_url は意図的に取らない。2026-09-20 時点で director の5行に
      // base64 data URI が入っており（合計60MB / 全16行）、このカラムを
      // SELECT するだけで statement timeout (57014) になっていた。一覧が
      // 常に「生成物の取得に失敗しました。」で開けず、取り残された LoRA
      // ジョブの強制終了ボタンにも辿り着けなくなっていた。サムネイルは
      // video_url を読まなくても signDirectorVideoUrl(user_id, job_id) で
      // 作れる（HMAC のみ・DB 非依存）。
      .select("id, user_id, status, workflow_type, result_path, credits_cost, error_message, created_at, metadata")
      .order("created_at", { ascending: false })
      .limit(PER_TABLE),
  ]);

  // 2026-09-20: どのテーブルで落ちたかを admin 画面へ返す。ここが黙って
  // 500 を返すだけだったため「最近の生成物」がずっと開けないことに気付けず、
  // 取り残された LoRA ジョブの強制終了ボタンにも辿り着けなかった。
  // admin 専用エンドポイントなので、理由をそのまま返してよい。
  const failed = ([
    ["angle_jobs", angle.error],
    ["upscale_jobs", upscale.error],
    ["generation_jobs", gen.error],
  ] as const).filter(([, e]) => e);
  if (failed.length > 0) {
    const reason = failed
      .map(([table, e]) => `${table}: ${e?.message ?? "unknown"}${e?.code ? ` (${e.code})` : ""}`)
      .join(" / ");
    console.error("[admin/generations] fetch failed:", reason);
    return NextResponse.json({ error: `生成物の取得に失敗しました。${reason}`, reason }, { status: 500 });
  }

  const rows: GenRow[] = [];

  for (const r of angle.data ?? []) {
    const imgs = Array.isArray(r.images) ? (r.images as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const rawThumb = imgs[0] ?? null;
    const thumbUrl =
      rawThumb && isVolumePath(rawThumb)
        ? (await presignPublishedArtifact(r.metadata, rawThumb)) ??
          signAngleImageUrl(r.user_id as string, r.id as string, rawThumb) ??
          rawThumb
        : rawThumb;
    rows.push({
      id: r.id as string,
      kind: "angle",
      label: `Multi-Angle · ${r.completed_angles ?? 0}/${r.total_angles ?? 0} 構図`,
      userId: r.user_id as string,
      userEmail: null,
      status: r.status as string,
      creditsCost: (r.credits_cost as number) ?? 0,
      thumbUrl,
      extra: imgs.length > 1 ? `他 ${imgs.length - 1} 枚` : null,
      errorMessage: (r.error_message as string) ?? null,
      createdAt: r.created_at as string,
      originalFilename: null,
    });
  }

  for (const r of upscale.data ?? []) {
    const meta = r.metadata as { original_available?: unknown; original_filename?: unknown } | null;
    const originalFilename =
      meta?.original_available === true && typeof meta.original_filename === "string"
        ? meta.original_filename
        : null;
    const rawResult = firstString(r.result_url);
    const thumbUrl =
      rawResult && isVolumePath(rawResult)
        ? (await presignPublishedArtifact(r.metadata, rawResult)) ??
          signUpscaleResultUrl(r.user_id as string, r.id as string, rawResult) ??
          rawResult
        : rawResult;
    rows.push({
      id: r.id as string,
      kind: "upscale",
      label:
        `超解像 · ${r.model_key ?? "?"} · ${r.preset ?? "?"}` +
        (r.batch_id ? ` · バッチ ${((r.batch_index as number) ?? 0) + 1}/${r.batch_total ?? "?"}` : ""),
      userId: r.user_id as string,
      userEmail: null,
      status: r.status as string,
      creditsCost: (r.credits_cost as number) ?? 0,
      thumbUrl,
      extra: null,
      errorMessage: (r.error_message as string) ?? null,
      createdAt: r.created_at as string,
      originalFilename,
      batchId: (r.batch_id as string | null) ?? null,
    });
  }

  for (const r of gen.data ?? []) {
    const wt = (r.workflow_type as string) ?? "";
    const isLora = wt === "lora_training";
    // video_url を読まずにサムネイルを決める（上の SELECT のコメント参照）。
    // director は Volume の実体を署名URLで直接配信できる。custom は
    // ファイル名が要る署名なので result_path から拾えるときだけ作る。
    const rawResultPath = isLora ? null : firstString(r.result_path);
    let thumbUrl: string | null = null;
    if (wt === "director") {
      thumbUrl =
        (await presignPublishedArtifact(r.metadata, `director_results/${r.user_id as string}/${r.id as string}.mp4`)) ??
        signDirectorVideoUrl(r.user_id as string, r.id as string);
    } else if (wt === "custom" && rawResultPath && isVolumePath(rawResultPath)) {
      thumbUrl =
        (await presignPublishedArtifact(r.metadata, rawResultPath)) ??
        signCustomWorkflowResultUrl(r.user_id as string, r.id as string, rawResultPath);
    }
    rows.push({
      id: r.id as string,
      kind: isLora ? "lora" : "video",
      label: isLora ? "LoRA 学習" : `動画 · ${wt || "?"}`,
      userId: r.user_id as string,
      userEmail: null,
      status: r.status as string,
      creditsCost: (r.credits_cost as number) ?? 0,
      thumbUrl,
      extra: isLora ? (firstString(r.result_path) ? `Volume: ${firstString(r.result_path)}` : null) : null,
      errorMessage: (r.error_message as string) ?? null,
      createdAt: r.created_at as string,
      originalFilename: null,
    });
  }

  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const page = rows.slice(0, RETURN_LIMIT);

  // user email 解決（このページに出てくる id ぶんだけ）。
  const ids = Array.from(new Set(page.map((r) => r.userId)));
  if (ids.length > 0) {
    const { data } = await supabaseAdmin.from("profiles").select("id, email").in("id", ids);
    const byId = new Map((data ?? []).map((r) => [r.id as string, (r.email as string) ?? null]));
    for (const r of page) r.userEmail = byId.get(r.userId) ?? null;
  }

  return NextResponse.json({ generations: page });
}
