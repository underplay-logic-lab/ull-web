import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Shared helpers for the LoRA Studio self-healing path — used by the
// /api/jobs/[id] poll (Modal-native container-death detection) and the
// /api/studio/lora/salvage route.

type JobRow = Record<string, unknown>;

// The Modal FunctionCall id (fc-...) — from the dedicated column, or from
// inputs jsonb when the DB is behind on the modal_call_id migration.
export function loraCallIdOf(job: JobRow): string {
  const col = job.modal_call_id;
  if (typeof col === "string" && col) return col;
  const inputs = job.inputs as { modal_call_id?: unknown } | null;
  return typeof inputs?.modal_call_id === "string" ? inputs.modal_call_id : "";
}

// Platform-defence policy: a job whose config came from the raw-YAML expert
// editor is the user's own responsibility — its failure does NOT refund.
export function isCustomYamlLoraJob(job: JobRow): boolean {
  const inputs = job.inputs as
    | {
        training_config?: { custom_yaml_override?: unknown };
        dispatch?: {
          custom_yaml_override?: unknown;
          training_config?: { custom_yaml_override?: unknown };
        };
      }
    | null;
  if (inputs?.training_config?.custom_yaml_override != null) return true;
  const d = inputs?.dispatch;
  return Boolean(d?.custom_yaml_override || d?.training_config?.custom_yaml_override);
}

// The dataset id (keys the persisted-caption cache on the Volume) — from
// inputs or the stored dispatch payload.
export function loraDatasetIdOf(job: JobRow): string {
  const inputs = job.inputs as
    | { dataset_id?: unknown; dispatch?: { dataset_id?: unknown } }
    | null;
  if (typeof inputs?.dataset_id === "string" && inputs.dataset_id) return inputs.dataset_id;
  const d = inputs?.dispatch;
  return typeof d?.dataset_id === "string" ? d.dataset_id : "";
}

export function loraOutputNameOf(job: JobRow): string {
  const inputs = job.inputs as
    | { output_lora_name?: unknown; dispatch?: { output_lora_name?: unknown } }
    | null;
  if (typeof inputs?.output_lora_name === "string" && inputs.output_lora_name) {
    return inputs.output_lora_name;
  }
  const d = inputs?.dispatch;
  return typeof d?.output_lora_name === "string" ? d.output_lora_name : "";
}

// generation_jobs UPDATE that survives a DB that's behind on migrations:
// drops 'failed_timeout' -> 'failed' if the status CHECK rejects it, and
// drops any column PostgREST doesn't know about. Mirrors the recover route's
// updateJob().
async function updateJobResilient(id: string, fields: Record<string, unknown>): Promise<void> {
  let f: Record<string, unknown> = { ...fields };
  for (let attempt = 0; attempt < 6; attempt++) {
    const { error } = await supabaseAdmin.from("generation_jobs").update(f).eq("id", id);
    if (!error) return;
    const msg = `${error.message} ${(error as { details?: string }).details ?? ""}`.toLowerCase();

    if (
      /check constraint|generation_jobs_status_check/.test(msg) &&
      (f.status === "failed_timeout" || f.status === "cancelled")
    ) {
      f = { ...f, status: "failed" };
      continue;
    }
    const col = msg.match(/'([a-z_]+)' column|column ["']?([a-z_]+)["']?/)?.slice(1).find(Boolean);
    if (col && col in f) {
      delete f[col];
      continue;
    }
    if (/schema cache|could not find/.test(msg)) {
      const base = new Set([
        "status",
        "error_message",
        "completed_at",
        "updated_at",
        "progress_message",
        "metadata",
        "inputs",
      ]);
      let changed = false;
      for (const k of Object.keys(f)) {
        if (!base.has(k)) {
          delete f[k];
          changed = true;
        }
      }
      if (changed) continue;
    }
    console.error("[loraJobHealth] updateJobResilient gave up:", error.message);
    return;
  }
}

async function refundCredits(userId: string, amount: number): Promise<void> {
  if (!userId || amount <= 0) return;
  const { data } = await supabaseAdmin.from("profiles").select("credits").eq("id", userId).single();
  const current = (data?.credits as number | null) ?? 0;
  await supabaseAdmin.from("profiles").update({ credits: current + amount }).eq("id", userId);
}

// Closes a job whose Modal container is confirmed dead (SIGKILL / OOM /
// eviction — train_lora_job's own except-block never ran). Marks it
// 'failed', records the reason, and 100%-refunds the cost once — unless it's
// a raw-YAML job (platform-defence: no refund), guarded by the `refunded`
// flag so a repeated poll can't double-credit.
export async function markLoraJobContainerDead(
  job: JobRow,
  detail: string,
): Promise<{ refunded: number; customYaml: boolean }> {
  const id = String(job.id);
  const userId = String(job.user_id ?? "");
  const customYaml = isCustomYamlLoraJob(job);
  const alreadyRefunded = Boolean(job.refunded);
  const cost = typeof job.credits_cost === "number" ? job.credits_cost : 0;
  const existingMeta =
    job.metadata && typeof job.metadata === "object" ? (job.metadata as Record<string, unknown>) : {};

  // Raw-YAML jobs get 12h of GPU time — a run that still hits that ceiling is
  // an over-scoped config, not our fault: refunding a full 12h burn would be
  // ruinous. So container timeout / SIGKILL is NOT refunded for raw-YAML
  // (only genuine GUI-mode faults are). In-worker transient infra failures
  // that abort early are handled separately (see _is_infra_error in the
  // worker) and DO refund.
  const reason = customYaml
    ? "12時間の実行上限に達したか、リソース制限で終了しました。解像度・ステップ数・バッチサイズを下げて、12時間以内に完了する設定にしてください。" +
      (detail ? ` [${detail}]` : "")
    : "コンテナが結果を返さずに終了しました（実行時間の上限超過・リソース制限などの可能性）。" +
      (detail ? ` [${detail}]` : "");

  let refunded = 0;
  if (!customYaml && !alreadyRefunded && cost > 0 && userId) {
    await refundCredits(userId, cost);
    refunded = cost;
  }

  await updateJobResilient(id, {
    status: "failed",
    error_message: ((customYaml ? "[Pro Custom YAML — 返金対象外] " : "") + reason).slice(0, 2000),
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    metadata: {
      ...existingMeta,
      refunded: !customYaml && (refunded > 0 || alreadyRefunded),
      custom_yaml: customYaml,
      container_death: true,
    },
  });
  return { refunded, customYaml };
}
