import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Volume 上のフォルダ名は `loras/<user_id>/<job_id>/` のように UUID が2段
// 並ぶだけで、admin から見ると「どれが何なのか」が全く分からない
// （ホスト指摘、2026-09-21）。ここで UUID を人間が読めるラベルへ解決する。
//
//   user_id -> そのユーザーのメールアドレス（profiles）
//   job_id  -> 「LoRA名 / ベースモデル / 学習日 / 状態」（generation_jobs）
//
// ファイルの実体は一切動かさない — 表示だけを足す方針。パス規約を変えると
// 既存ジョブの metadata.checkpoints やダウンロード API の互換性に波及するため。
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VolumePathLabel = {
  kind: "user" | "job";
  label: string;
  sub?: string;
};

function firstString(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function jobLabel(row: Record<string, unknown>): VolumePathLabel {
  const inputs = (row.inputs ?? {}) as Record<string, unknown>;
  const tc = (inputs.training_config ?? {}) as Record<string, unknown>;
  const name =
    firstString(inputs.output_lora_name) || firstString(row.workflow_type) || "（名前なし）";
  const model = firstString(inputs.target_model);
  const steps = typeof tc.steps === "number" ? `${tc.steps}step` : "";
  const created = firstString(row.created_at).slice(0, 10);
  const status = firstString(row.status);
  const statusJa =
    status === "completed"
      ? "完了"
      : status === "failed"
        ? "失敗"
        : status === "processing"
          ? "実行中"
          : status;
  return {
    kind: "job",
    label: name,
    sub: [created, model, steps, statusJa].filter(Boolean).join(" · "),
  };
}

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  const ids = Array.isArray(body?.ids)
    ? Array.from(
        new Set(
          (body.ids as unknown[]).filter((v): v is string => typeof v === "string" && UUID_RE.test(v)),
        ),
      ).slice(0, 300)
    : [];
  if (ids.length === 0) return NextResponse.json({ labels: {} });

  const labels: Record<string, VolumePathLabel> = {};
  // 1回のリクエストに user_id と job_id が混在するので、両方を同じ id 集合で
  // 引いて当たった方を採用する（UUID なので衝突しない）。
  const [jobs, profiles] = await Promise.all([
    supabaseAdmin
      .from("generation_jobs")
      .select("id, status, workflow_type, inputs, created_at")
      .in("id", ids),
    supabaseAdmin.from("profiles").select("id, email").in("id", ids),
  ]);

  if (jobs.error) console.error("[admin/modal/storage/labels] jobs:", jobs.error.message);
  if (profiles.error) console.error("[admin/modal/storage/labels] profiles:", profiles.error.message);

  for (const row of jobs.data ?? []) {
    labels[row.id as string] = jobLabel(row as Record<string, unknown>);
  }
  for (const row of profiles.data ?? []) {
    const id = row.id as string;
    if (labels[id]) continue; // ジョブ側で解決済みなら優先
    labels[id] = { kind: "user", label: firstString(row.email) || "（不明なユーザー）" };
  }

  return NextResponse.json({ labels });
}
