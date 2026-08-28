"use client";

import { Trash2 } from "lucide-react";
import {
  WORKFLOW_INPUT_FIELD_TYPES,
  WORKFLOW_FIELD_TIERS,
  type WorkflowFieldColSpan,
  type WorkflowFieldOption,
  type WorkflowFieldTier,
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

// Right pane (30%): full property + dynamic-pricing editor for the selected field.
export function ParameterInspectorPane({
  field,
  sections,
  onChange,
  onRemove,
}: {
  field: WorkflowInputField | null;
  sections: WorkflowSection[];
  onChange: (patch: Partial<WorkflowInputField>) => void;
  onRemove: () => void;
}) {
  if (!field) {
    return (
      <div className="flex h-full items-center justify-center border-l border-border bg-surface/30 p-6 text-center text-[11px] text-muted">
        中央のキャンバスでフィールドを選択すると、ここで詳細を編集できます。
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
        <div className="space-y-2">
          <div>
            <label className={labelCls}>ラベル</label>
            <input value={field.label} onChange={(e) => onChange({ label: e.target.value })} className={inputCls} />
          </div>
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
              <label className={labelCls}>node_id</label>
              <input
                value={field.node_id}
                onChange={(e) => onChange({ node_id: e.target.value })}
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label className={labelCls}>field</label>
              <input
                value={field.field}
                onChange={(e) => onChange({ field: e.target.value })}
                className={`${inputCls} font-mono`}
              />
            </div>
          </div>
        </div>

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

        {/* ⚡ Dynamic credit pricing */}
        <div className="space-y-2 rounded-lg border border-neon-pink/30 bg-neon-pink/5 p-2.5">
          <p className="text-[10px] font-semibold text-neon-pink">⚡ 動的クレジット課金設定</p>

          {field.type === "toggle" && (
            <div>
              <label className={labelCls}>ON 時の加算クレジット</label>
              <input
                type="number"
                value={field.credits_add ?? ""}
                onChange={(e) =>
                  onChange({ credits_add: e.target.value === "" ? undefined : Number(e.target.value) })
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
                  onChange({ credits_add: e.target.value === "" ? undefined : Number(e.target.value) })
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
                  onChange={(e) =>
                    onChange({ credits_baseline: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>1単位あたり加算 (Per unit)</label>
                <input
                  type="number"
                  step="any"
                  value={field.credits_per_unit ?? ""}
                  onChange={(e) =>
                    onChange({ credits_per_unit: e.target.value === "" ? undefined : Number(e.target.value) })
                  }
                  className={inputCls}
                />
              </div>
              <p className="col-span-2 text-[9px] text-muted">
                Per unit 未設定時は「基準値から動かしたら +加算クレジット」の固定加算として扱われます。
              </p>
            </div>
          )}

          {field.type === "select" && (
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
      </div>
    </div>
  );
}
