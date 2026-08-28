"use client";

import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import {
  SYSTEM_FIELD_GPU_TIER,
  WORKFLOW_GPU_TIERS,
  WORKFLOW_GPU_SPEC_BY_TIER,
  WORKFLOW_INPUT_FIELD_TYPES,
  WORKFLOW_FIELD_TIERS,
  type WorkflowFieldColSpan,
  type WorkflowFieldOption,
  type WorkflowFieldTier,
  type WorkflowGpuTier,
  type WorkflowInputField,
  type WorkflowInputFieldType,
  type WorkflowSection,
} from "@/lib/customWorkflows";
import { COL_SPAN_OPTIONS } from "@/lib/workflowLayout";

const TYPE_LABEL: Record<WorkflowInputFieldType, string> = {
  text: "テキスト",
  image: "画像",
  video: "動画",
  slider: "スライダー",
  toggle: "トグル",
  select: "セレクト",
};

const TIER_LABEL: Record<WorkflowFieldTier, string> = {
  free: "Free",
  entry: "Entry",
  standard: "Standard",
  pro: "Pro",
  master: "Master",
};

const inputCls =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-neon-violet/50";
const labelCls = "mb-1 block text-[10px] font-medium text-muted";

// Builds a numeric field patch from a raw <input> value: "" or an
// unparseable value clears the prop (undefined), otherwise it's the parsed
// number. Used by the ⚡ pricing inputs so an admin's typed value is always
// stored, not left at a stale default.
function numPatch(
  key: "credits_baseline" | "credits_per_unit" | "credits_add",
  raw: string,
): Partial<WorkflowInputField> {
  if (raw.trim() === "") return { [key]: undefined };
  const n = Number(raw);
  return { [key]: Number.isNaN(n) ? undefined : n };
}

// Workflow-level GPU fallback chain editor — a priority-ordered list Modal
// walks down when the preferred GPU is congested. Rendered whether or not a
// field is selected (it's workflow config, not field config).
function GpuFallbackChainEditor({
  list,
  onChange,
}: {
  list: WorkflowGpuTier[];
  onChange: (next: WorkflowGpuTier[]) => void;
}) {
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i));
  const add = (tier: WorkflowGpuTier) => {
    if (list.includes(tier)) return;
    onChange([...list, tier]);
  };
  const remaining = WORKFLOW_GPU_TIERS.filter((t) => !list.includes(t.value));

  return (
    <div className="space-y-1.5 rounded-lg border border-neon-violet/30 bg-neon-violet/5 p-2.5">
      <p className="text-[10px] font-semibold text-neon-violet">⚡ GPU フォールバックチェーン（混雑回避）</p>
      <p className="text-[8px] text-muted">
        優先順位順（上ほど優先）。先頭の GPU が在庫切れ・混雑時に、次の GPU へ自動でフォールバックします。
        空の場合はワークフロー既定の GPU のみで実行します。
      </p>
      {list.length === 0 && (
        <p className="rounded bg-border/40 px-2 py-1.5 text-[9px] text-muted">未設定（フォールバックなし）</p>
      )}
      {list.map((tier, i) => {
        const spec = WORKFLOW_GPU_SPEC_BY_TIER[tier];
        return (
          <div key={tier} className="flex items-center gap-1.5 rounded-md border border-border bg-background p-1.5">
            <span className="w-4 shrink-0 text-center font-mono text-[9px] text-neon-violet">{i + 1}</span>
            <span className="flex-1 truncate text-[10px] text-foreground">
              {spec?.label ?? tier}
              <span className="ml-1 font-mono text-[8px] text-muted">
                {spec ? `${spec.vram} / $${spec.hourlyUsd.toFixed(2)}/h` : ""}
              </span>
            </span>
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              className="shrink-0 text-muted transition-colors hover:text-foreground disabled:opacity-30"
              title="優先度を上げる"
            >
              <ChevronUp size={12} />
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === list.length - 1}
              className="shrink-0 text-muted transition-colors hover:text-foreground disabled:opacity-30"
              title="優先度を下げる"
            >
              <ChevronDown size={12} />
            </button>
            <button
              type="button"
              onClick={() => remove(i)}
              className="shrink-0 text-muted transition-colors hover:text-red-400"
              title="チェーンから外す"
            >
              <Trash2 size={11} />
            </button>
          </div>
        );
      })}
      {remaining.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) add(e.target.value as WorkflowGpuTier);
          }}
          className={`${inputCls} mt-1`}
        >
          <option value="">＋ GPU をチェーンに追加…</option>
          {remaining.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}（{t.vram} / ${t.hourlyUsd.toFixed(2)}/h）
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// Right pane (30%): full property + dynamic-pricing editor for the selected field.
export function ParameterInspectorPane({
  field,
  sections,
  gpuFallbackList = [],
  onChange,
  onGpuFallbackChange,
  onRemove,
}: {
  field: WorkflowInputField | null;
  sections: WorkflowSection[];
  gpuFallbackList?: WorkflowGpuTier[];
  onChange: (patch: Partial<WorkflowInputField>) => void;
  onGpuFallbackChange?: (next: WorkflowGpuTier[]) => void;
  onRemove: () => void;
}) {
  if (!field) {
    return (
      <div className="flex h-full flex-col border-l border-border bg-surface/30">
        <div className="border-b border-border p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neon-violet">ワークフロー設定</h2>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-3">
          <p className="rounded-lg border border-dashed border-border p-3 text-center text-[11px] text-muted">
            中央のキャンバスでフィールドを選択すると、ここで詳細を編集できます。
          </p>
          {onGpuFallbackChange && (
            <GpuFallbackChainEditor list={gpuFallbackList} onChange={onGpuFallbackChange} />
          )}
        </div>
      </div>
    );
  }

  const options = field.options ?? [];
  const setOption = (i: number, patch: Partial<WorkflowFieldOption>) => {
    onChange({ options: options.map((o, idx) => (idx === i ? { ...o, ...patch } : o)) });
  };
  const addOption = () =>
    onChange({ options: [...options, { label: `選択肢${options.length + 1}`, value: `opt${options.length + 1}` }] });
  const removeOption = (i: number) => onChange({ options: options.filter((_, idx) => idx !== i) });

  const isGpuField = field.id === SYSTEM_FIELD_GPU_TIER;
  const gpuOptionRows = WORKFLOW_GPU_TIERS.map((t) => ({ value: t.value, defaultLabel: t.label }));
  const setGpuOption = (val: string, patch: Partial<WorkflowFieldOption>) => {
    const existing = options.find((o) => String(o.value) === val);
    const next = existing
      ? options.map((o) => (String(o.value) === val ? { ...o, ...patch } : o))
      : [
          ...options,
          {
            label: WORKFLOW_GPU_TIERS.find((t) => t.value === val)?.label ?? val,
            value: val,
            enabled: true,
            ...patch,
          },
        ];
    onChange({ options: next });
  };

  return (
    <div className="flex h-full flex-col border-l border-border bg-surface/30">
      <div className="flex items-center justify-between border-b border-border p-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neon-violet">フィールド設定</h2>
        <button
          type="button"
          onClick={onRemove}
          className="flex items-center gap-1 text-[10px] text-muted transition-colors hover:text-red-400"
        >
          <Trash2 size={11} />
          削除
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {isGpuField && (
          <div className="rounded-lg border border-neon-pink/30 bg-neon-pink/5 p-2.5 text-[10px] text-neon-pink">
            ⚡ システムフィールド（GPU選択セレクター）。位置・横幅・セクション・MinTier
            と各GPUの表示名／有効化／加算クレジットを設定できます。
          </div>
        )}
        <div className="space-y-2">
          <div>
            <label className={labelCls}>ラベル</label>
            <input value={field.label} onChange={(e) => onChange({ label: e.target.value })} className={inputCls} />
          </div>
          {!isGpuField && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>パラメータ名 (id)</label>
                  <input
                    value={field.id}
                    onChange={(e) => onChange({ id: e.target.value })}
                    className={`${inputCls} font-mono`}
                  />
                </div>
                <div>
                  <label className={labelCls}>タイプ</label>
                  <select
                    value={field.type}
                    onChange={(e) => onChange({ type: e.target.value as WorkflowInputFieldType })}
                    className={inputCls}
                  >
                    {WORKFLOW_INPUT_FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={`${labelCls} flex items-center gap-1`}>
                    node_id <span className="rounded bg-border px-1 text-[8px] text-muted">🔒 自動</span>
                  </label>
                  <input
                    value={field.node_id}
                    readOnly
                    disabled
                    className={`${inputCls} cursor-not-allowed font-mono opacity-60`}
                  />
                </div>
                <div>
                  <label className={`${labelCls} flex items-center gap-1`}>
                    field <span className="rounded bg-border px-1 text-[8px] text-muted">🔒 自動</span>
                  </label>
                  <input
                    value={field.field}
                    readOnly
                    disabled
                    className={`${inputCls} cursor-not-allowed font-mono opacity-60`}
                  />
                </div>
              </div>
              <p className="text-[9px] text-muted">
                node_id / field は左ペインの「UIに公開」からのみバインドされます（手動変更による ComfyUI グラフ破壊を防止）。
              </p>
            </>
          )}
        </div>

        {/* GPU tier option editor */}
        {isGpuField && (
          <div className="space-y-1.5 rounded-lg border border-neon-pink/30 bg-neon-pink/5 p-2.5">
            <p className="text-[10px] font-semibold text-neon-pink">⚡ GPU選択肢 ＆ 課金設定</p>
            <p className="text-[8px] text-muted">
              総クレジット = ⌈(ベース + Σ固定加算) × Π倍率⌉
            </p>
            {gpuOptionRows.map((row) => {
              const opt = options.find((o) => String(o.value) === row.value);
              const enabled = opt ? opt.enabled !== false : true;
              const spec = WORKFLOW_GPU_SPEC_BY_TIER[row.value];
              return (
                <div key={row.value} className="rounded-md border border-border bg-background p-1.5">
                  <div className="flex items-center gap-2">
                    <label className="flex shrink-0 items-center gap-1 text-[9px] text-muted">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => setGpuOption(row.value, { enabled: e.target.checked })}
                        className="h-3 w-3 accent-neon-pink"
                      />
                      有効
                    </label>
                    <input
                      value={opt?.label ?? row.defaultLabel}
                      onChange={(e) => setGpuOption(row.value, { label: e.target.value })}
                      placeholder={row.defaultLabel}
                      className={`${inputCls} flex-1`}
                      title="ユーザーに見える表示名"
                    />
                  </div>
                  {spec && (
                    <p className="mt-1 rounded bg-border/60 px-1.5 py-0.5 font-mono text-[8px] text-muted">
                      物理: {spec.label} {spec.vram} / ${spec.hourlyUsd.toFixed(2)}/h
                    </p>
                  )}
                  <div className="mt-1.5 flex items-center gap-2">
                    <label className="flex flex-1 items-center gap-1 text-[9px] text-muted">
                      倍率 ×
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={opt?.multiplier ?? ""}
                        onChange={(e) =>
                          setGpuOption(row.value, {
                            multiplier: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                        placeholder="1.0"
                        className={`${inputCls} w-16`}
                      />
                    </label>
                    <label className="flex flex-1 items-center gap-1 text-[9px] text-muted">
                      固定加算 +
                      <input
                        type="number"
                        step="any"
                        value={opt?.credits_add ?? ""}
                        onChange={(e) =>
                          setGpuOption(row.value, {
                            credits_add: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                        placeholder="0"
                        className={`${inputCls} w-16`}
                      />
                      C
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* GPU fallback chain — workflow-level, shown alongside the GPU field editor */}
        {isGpuField && onGpuFallbackChange && (
          <GpuFallbackChainEditor list={gpuFallbackList} onChange={onGpuFallbackChange} />
        )}

        {/* Field height */}
        {field.type === "text" && (
          <div className="rounded-lg border border-border bg-background/60 p-2.5">
            <label className={labelCls}>入力欄の行数 (rows)</label>
            <div className="flex gap-1">
              {[2, 4, 6, 8].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onChange({ rows: r })}
                  className={`flex-1 rounded-md border px-1 py-1 text-[10px] font-medium transition-colors ${
                    (field.rows ?? 3) === r
                      ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                      : "border-border text-muted hover:text-foreground"
                  }`}
                >
                  {r}行
                </button>
              ))}
              <button
                type="button"
                onClick={() => onChange({ rows: undefined })}
                className={`flex-1 rounded-md border px-1 py-1 text-[10px] font-medium transition-colors ${
                  field.rows === undefined
                    ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                    : "border-border text-muted hover:text-foreground"
                }`}
              >
                標準
              </button>
            </div>
          </div>
        )}
        {(field.type === "image" || field.type === "video") && (
          <div className="rounded-lg border border-border bg-background/60 p-2.5">
            <label className={labelCls}>アップロード欄の高さ</label>
            <div className="grid grid-cols-2 gap-1">
              {(
                [
                  ["compact", "コンパクト"],
                  ["standard", "標準"],
                  ["large", "大"],
                  ["square", "正方形"],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onChange({ heightPreset: field.heightPreset === v ? undefined : v })}
                  className={`rounded-md border px-1 py-1 text-[10px] font-medium transition-colors ${
                    field.heightPreset === v
                      ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                      : "border-border text-muted hover:text-foreground"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Layout */}
        <div className="space-y-2 rounded-lg border border-border bg-background/60 p-2.5">
          <p className="text-[10px] font-semibold text-neon-violet">レイアウト（12カラム）</p>
          <div>
            <label className={labelCls}>横幅 (ColSpan)</label>
            <div className="flex gap-1">
              {COL_SPAN_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ colSpan: opt.value })}
                  className={`flex-1 rounded-md border px-1 py-1 text-[10px] font-medium transition-colors ${
                    (field.colSpan ?? 12) === opt.value
                      ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                      : "border-border text-muted hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Row（任意）</label>
              <input
                type="number"
                value={field.row ?? ""}
                onChange={(e) => onChange({ row: e.target.value === "" ? undefined : Number(e.target.value) })}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>セクション</label>
              <select
                value={field.sectionId ?? ""}
                onChange={(e) => onChange({ sectionId: e.target.value || undefined })}
                className={inputCls}
              >
                <option value="">（未指定）</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>MinTier（この Tier 以上に表示）</label>
            <select
              value={field.minTier ?? ""}
              onChange={(e) => onChange({ minTier: (e.target.value || undefined) as WorkflowFieldTier | undefined })}
              className={inputCls}
            >
              <option value="">制限なし</option>
              {WORKFLOW_FIELD_TIERS.map((t) => (
                <option key={t} value={t}>
                  {TIER_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <span className="text-[9px] text-muted">
              現在: md:col-span-{(field.colSpan ?? 12) as WorkflowFieldColSpan}
            </span>
          </div>
        </div>

        {/* Slider range */}
        {field.type === "slider" && (
          <div className="grid grid-cols-4 gap-1.5 rounded-lg border border-border bg-background/60 p-2.5">
            {(["default", "min", "max", "step"] as const).map((k) => (
              <div key={k}>
                <label className={labelCls}>{k}</label>
                <input
                  type="number"
                  step="any"
                  value={
                    k === "default"
                      ? typeof field.default === "number"
                        ? field.default
                        : ""
                      : (field[k] ?? "")
                  }
                  onChange={(e) => {
                    const v = e.target.value === "" ? undefined : Number(e.target.value);
                    onChange(k === "default" ? { default: v } : { [k]: v });
                  }}
                  className={inputCls}
                />
              </div>
            ))}
          </div>
        )}

        {/* Toggle default */}
        {field.type === "toggle" && (
          <div className="rounded-lg border border-border bg-background/60 p-2.5">
            <label className={labelCls}>初期値</label>
            <select
              value={field.default === true ? "true" : "false"}
              onChange={(e) => onChange({ default: e.target.value === "true" })}
              className={inputCls}
            >
              <option value="false">OFF</option>
              <option value="true">ON</option>
            </select>
          </div>
        )}

        {/* ⚡ Dynamic credit pricing (the GPU field uses its own editor above) */}
        {!isGpuField && (
        <div className="space-y-2 rounded-lg border border-neon-pink/30 bg-neon-pink/5 p-2.5">
          <p className="text-[10px] font-semibold text-neon-pink">⚡ 動的クレジット課金設定</p>

          {field.type === "toggle" && (
            <div>
              <label className={labelCls}>ON 時の加算クレジット</label>
              <input
                type="number"
                value={field.credits_add ?? ""}
                onChange={(e) =>
                  onChange(numPatch("credits_add", e.target.value))
                }
                className={inputCls}
              />
            </div>
          )}

          {(field.type === "text" || field.type === "image" || field.type === "video") && (
            <div>
              <label className={labelCls}>選択（入力）時の加算クレジット</label>
              <input
                type="number"
                value={field.credits_add ?? ""}
                onChange={(e) =>
                  onChange(numPatch("credits_add", e.target.value))
                }
                className={inputCls}
              />
            </div>
          )}

          {field.type === "slider" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>基準値 (Baseline)</label>
                <input
                  type="number"
                  step="any"
                  value={field.credits_baseline ?? ""}
                  onChange={(e) => onChange(numPatch("credits_baseline", e.target.value))}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>1単位あたり加算 (Per unit)</label>
                <input
                  type="number"
                  step="any"
                  value={field.credits_per_unit ?? ""}
                  onChange={(e) => onChange(numPatch("credits_per_unit", e.target.value))}
                  className={inputCls}
                />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>固定加算 (Per unit 未設定時)</label>
                <input
                  type="number"
                  step="any"
                  value={field.credits_add ?? ""}
                  onChange={(e) => onChange(numPatch("credits_add", e.target.value))}
                  className={inputCls}
                />
              </div>
              <p className="col-span-2 text-[9px] text-muted">
                Per unit を設定すると「(値 − Baseline) 単位 × Per unit」で従量課金。未設定なら「Baseline
                から動かしたら 固定加算」。
              </p>
            </div>
          )}

          {field.type === "select" && !isGpuField && (
            <div className="space-y-1.5">
              <label className={labelCls}>選択肢と各オプションの加算クレジット</label>
              {options.map((opt, i) => (
                <div key={i} className="rounded-md border border-border bg-background p-1.5">
                  <div className="grid grid-cols-2 gap-1.5">
                    <input
                      value={opt.label}
                      onChange={(e) => setOption(i, { label: e.target.value })}
                      placeholder="ラベル"
                      className={inputCls}
                    />
                    <input
                      value={String(opt.value)}
                      onChange={(e) => setOption(i, { value: e.target.value })}
                      placeholder="value"
                      className={`${inputCls} font-mono`}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      type="number"
                      value={opt.credits_add ?? ""}
                      onChange={(e) =>
                        setOption(i, {
                          credits_add: e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                      placeholder="加算C"
                      className={`${inputCls} flex-1`}
                    />
                    <label className="flex shrink-0 items-center gap-1 text-[9px] text-muted">
                      <input
                        type="checkbox"
                        checked={Boolean(opt.is_base_override)}
                        onChange={(e) => setOption(i, { is_base_override: e.target.checked })}
                        className="h-3 w-3 accent-neon-pink"
                      />
                      ベース上書き
                    </label>
                    <button
                      type="button"
                      onClick={() => removeOption(i)}
                      className="shrink-0 text-muted hover:text-red-400"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addOption}
                className="w-full rounded-md border border-dashed border-border py-1 text-[10px] text-muted hover:text-foreground"
              >
                + 選択肢を追加
              </button>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
