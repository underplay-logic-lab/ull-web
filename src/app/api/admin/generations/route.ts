import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// admin「生成物 & ストレージ」— 最近の生成物ビュー。
// angle_jobs / upscale_jobs / generation_jobs を横断し、共通形に正規化して
// 新しい順に返す。各テーブルから PER_TABLE 件ずつ取ってマージ・カット。

const PER_TABLE = 60;
const RETURN_LIMIT = 100;

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
      .select("id, user_id, status, mode, total_angles, completed_angles, images, credits_cost, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(PER_TABLE),
    supabaseAdmin
      .from("upscale_jobs")
      .select("id, user_id, status, model_key, preset, result_url, credits_cost, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(PER_TABLE),
    supabaseAdmin
      .from("generation_jobs")
      .select("id, user_id, status, workflow_type, video_url, result_path, credits_cost, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(PER_TABLE),
  ]);

  const err = angle.error || upscale.error || gen.error;
  if (err) {
    console.error("[admin/generations] fetch failed:", err.message);
    return NextResponse.json({ error: "生成物の取得に失敗しました。" }, { status: 500 });
  }

  const rows: GenRow[] = [];

  for (const r of angle.data ?? []) {
    const imgs = Array.isArray(r.images) ? (r.images as unknown[]).filter((x): x is string => typeof x === "string") : [];
    rows.push({
      id: r.id as string,
      kind: "angle",
      label: `Multi-Angle · ${r.completed_angles ?? 0}/${r.total_angles ?? 0} 構図`,
      userId: r.user_id as string,
      userEmail: null,
      status: r.status as string,
      creditsCost: (r.credits_cost as number) ?? 0,
      thumbUrl: imgs[0] ?? null,
      extra: imgs.length > 1 ? `他 ${imgs.length - 1} 枚` : null,
      errorMessage: (r.error_message as string) ?? null,
      createdAt: r.created_at as string,
    });
  }

  for (const r of upscale.data ?? []) {
    rows.push({
      id: r.id as string,
      kind: "upscale",
      label: `超解像 · ${r.model_key ?? "?"} · ${r.preset ?? "?"}`,
      userId: r.user_id as string,
      userEmail: null,
      status: r.status as string,
      creditsCost: (r.credits_cost as number) ?? 0,
      thumbUrl: firstString(r.result_url),
      extra: null,
      errorMessage: (r.error_message as string) ?? null,
      createdAt: r.created_at as string,
    });
  }

  for (const r of gen.data ?? []) {
    const wt = (r.workflow_type as string) ?? "";
    const isLora = wt === "lora_training";
    rows.push({
      id: r.id as string,
      kind: isLora ? "lora" : "video",
      label: isLora ? "LoRA 学習" : `動画 · ${wt || "?"}`,
      userId: r.user_id as string,
      userEmail: null,
      status: r.status as string,
      creditsCost: (r.credits_cost as number) ?? 0,
      thumbUrl: isLora ? null : firstString(r.video_url),
      extra: isLora ? (firstString(r.result_path) ? `Volume: ${firstString(r.result_path)}` : null) : null,
      errorMessage: (r.error_message as string) ?? null,
      createdAt: r.created_at as string,
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
