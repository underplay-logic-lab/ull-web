import yaml from "js-yaml";

// Shared YAML validation for the "生YAML" expert editor — used both by the
// LoRA Studio UI (live badge + submit gate) and by /api/studio/lora/train
// (400 before any Modal container spins up). Same rules on both sides.

export type LoraYamlValidation =
  | { ok: true; data: unknown; warnings: string[] }
  | {
      ok: false;
      message: string;
      line: number | null;
      column: number | null;
      // present for semantic/schema failures (not syntax) — one line each,
      // already prefixed with ❌.
      errors?: string[];
    };

const ALLOWED_OPTIMIZERS = ["adamw", "adamw8bit", "adamw_bf16", "prodigy", "lion", "adam"];

// js-yaml's YAMLException — .mark line/column are 0-indexed.
type YamlEx = {
  name?: string;
  reason?: string;
  message?: string;
  mark?: { line: number; column: number };
};

export function validateLoraYaml(text: string): LoraYamlValidation {
  let data: unknown;
  try {
    data = yaml.load(text);
  } catch (e) {
    const ex = e as YamlEx;
    return {
      ok: false,
      message: ex.reason || ex.message || "構文エラー",
      line: ex.mark ? ex.mark.line + 1 : null,
      column: ex.mark ? ex.mark.column + 1 : null,
    };
  }
  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      message: "無効な YAML 設定です: 有効な設定オブジェクト（マッピング）ではありません。",
      line: null,
      column: null,
      errors: ["❌ 無効な YAML 設定です: 有効な設定オブジェクト（マッピング）ではありません。"],
    };
  }
  // Structural prerequisites ai-toolkit's toolkit/config.py enforces before it
  // reads anything else. A miss here is the "config file must have a job key"
  // ValueError that would otherwise only surface AFTER the Modal container
  // starts — a non-refundable wasted launch.
  const structureErrors = collectLoraYamlStructureErrors(data);
  if (structureErrors.length > 0) {
    return { ok: false, message: structureErrors.join(" / "), line: null, column: null, errors: structureErrors };
  }
  const errors = collectLoraYamlErrors(data);
  if (errors.length > 0) {
    return { ok: false, message: errors.join(" / "), line: null, column: null, errors };
  }
  return { ok: true, data, warnings: collectLoraYamlWarnings(data) };
}

// ai-toolkit hard-requires a root `job` string (usually "extension") and a
// root `config` mapping whose `process` is a non-empty list. Missing any of
// these makes `toolkit/config.py` raise before the trainer even loads — this
// is the gate that keeps such a YAML from ever reaching a GPU container.
// Returned strings are display-ready (❌-prefixed), one per line.
export function collectLoraYamlStructureErrors(data: unknown): string[] {
  const errs: string[] = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return ["❌ 無効な YAML 設定です: 有効な設定オブジェクト（マッピング）ではありません。"];
  }
  const root = data as Record<string, unknown>;

  const job = root.job;
  if (job === undefined || job === null || (typeof job === "string" && job.trim() === "")) {
    errs.push("❌ 無効な YAML 設定です: ルートレベルに `job: extension` が必要です。");
  } else if (typeof job !== "string") {
    errs.push("❌ 無効な YAML 設定です: `job` は文字列で指定してください（通常は `job: extension`）。");
  }

  const config = root.config;
  if (config === undefined || config === null) {
    errs.push("❌ 無効な YAML 設定です: ルートレベルに `config`（オブジェクト）が必要です。");
    return errs;
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    errs.push("❌ 無効な YAML 設定です: `config` はオブジェクト（マッピング）で指定してください。");
    return errs;
  }

  const process = (config as Record<string, unknown>).process;
  if (!Array.isArray(process) || process.length === 0) {
    errs.push("❌ 無効な YAML 設定です: `config.process` の定義が見つかりません（1要素以上のリストが必要です）。");
  }

  return errs;
}

// The LoRA name + trigger word declared inside a raw ai-toolkit YAML. In
// raw-YAML mode these are authoritative (the form fields are disabled) — used
// by the UI to display / submit them and by /api/studio/lora/train to price
// and dispatch with the right identity.
export function loraYamlIdentity(data: unknown): { name: string; triggerWord: string } {
  const cfg = (data as { config?: { name?: unknown; process?: unknown[] } })?.config;
  const name = typeof cfg?.name === "string" ? cfg.name.trim() : "";
  const p0 = Array.isArray(cfg?.process) ? cfg?.process?.[0] : null;
  const tw =
    p0 && typeof p0 === "object" && typeof (p0 as Record<string, unknown>).trigger_word === "string"
      ? String((p0 as Record<string, unknown>).trigger_word).trim()
      : "";
  return { name, triggerWord: tw };
}

// Hard schema rules — a match here blocks submit (ok: false).
export function collectLoraYamlErrors(data: unknown): string[] {
  const errors: string[] = [];

  // In raw-YAML mode the YAML's config.name IS the LoRA name (the form field
  // is disabled), so it must be present and filesystem-safe.
  const cfgName = (data as { config?: { name?: unknown } })?.config?.name;
  const name = typeof cfgName === "string" ? cfgName.trim() : "";
  if (!name) {
    errors.push("❌ config.name が必要です（生YAMLモードでは これが LoRA 名になります）");
  } else if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    errors.push("❌ config.name は英数字・ハイフン・アンダースコア・ドットのみ（64文字以内）にしてください");
  }

  const proc = (data as { config?: { process?: unknown[] } })?.config?.process?.[0];
  if (!proc || typeof proc !== "object") return errors;
  const p = proc as { train?: unknown; model?: unknown; datasets?: unknown };

  const train = p.train && typeof p.train === "object" && !Array.isArray(p.train)
    ? (p.train as Record<string, unknown>)
    : null;
  const model = p.model && typeof p.model === "object" && !Array.isArray(p.model)
    ? (p.model as Record<string, unknown>)
    : null;

  // 1. minimax_h3 requires noise_scheduler: flowmatch
  const arch = String(model?.arch ?? "").trim();
  if (arch === "minimax_h3" && train && "noise_scheduler" in train) {
    if (String(train.noise_scheduler) !== "flowmatch") {
      errors.push('❌ minimax_h3 では noise_scheduler: "flowmatch" が必須です');
    }
  }

  // 2. optimizer whitelist
  if (train && train.optimizer !== undefined) {
    const val = String(train.optimizer);
    if (!ALLOWED_OPTIMIZERS.includes(val)) {
      errors.push(`❌ 未知の optimizer: "${val}" です`);
    }
  }

  // 3. datasets[].resolution must be a list of positive integers
  const datasets = Array.isArray(p.datasets) ? p.datasets : [];
  for (const ds of datasets) {
    if (!ds || typeof ds !== "object") continue;
    const resv = (ds as Record<string, unknown>).resolution;
    if (resv === undefined) continue;
    const okList =
      Array.isArray(resv) &&
      resv.length > 0 &&
      resv.every((n) => typeof n === "number" && Number.isInteger(n) && n > 0);
    if (!okList) {
      errors.push("❌ resolution は整数のリスト形式で指定してください");
      break;
    }
  }

  return errors;
}

// Non-fatal schema hints — the most common ai-toolkit key typos.
export function collectLoraYamlWarnings(data: unknown): string[] {
  const warnings: string[] = [];
  const proc = (data as { config?: { process?: unknown[] } })?.config?.process?.[0];
  const train =
    proc && typeof proc === "object" ? (proc as { train?: unknown }).train : undefined;
  if (train && typeof train === "object" && !Array.isArray(train)) {
    const t = train as Record<string, unknown>;
    if ("lr_schedule" in t && !("lr_scheduler" in t)) {
      warnings.push("`lr_schedule` は無効なキーです。`lr_scheduler` を使用してください");
    }
    // ai-toolkit's cosine schedulers map to torch CosineAnnealingWarmRestarts,
    // which has no num_cycles / warmup_steps (those are HuggingFace args) —
    // passing them crashes the run AFTER the model download. Catch it here.
    const params = t.lr_scheduler_params;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const bad = ["num_cycles", "warmup_steps", "num_warmup_steps"].filter(
        (k) => k in (params as Record<string, unknown>),
      );
      if (bad.length > 0) {
        warnings.push(
          `\`lr_scheduler_params\` の ${bad.map((k) => `\`${k}\``).join(" / ")} は ai-toolkit では無効です。` +
            "`lr_scheduler: \"cosine\"` にして `lr_scheduler_params` を削除するのが安全です",
        );
      }
    }
  }
  return warnings;
}
