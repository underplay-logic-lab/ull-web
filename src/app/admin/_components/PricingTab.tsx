"use client";

import { useEffect, useMemo, useState } from "react";
import { Calculator, Check, Loader2, Save } from "lucide-react";
import type { PricingKnobRow, StudioPricing } from "./types";

type EditableRow = {
  label: string;
  credits: string;
  unit_cost_usd: string;
};

const CATEGORY_LABELS: Record<PricingKnobRow["category"], string> = {
  feature_credits: "機能クレジット単価",
  lora_formula: "LoRA 学習の課金係数",
  cost_guard: "原価割れ損切り（ウォッチドッグ）閾値",
  rates: "レート・GPU 原価",
};

const CATEGORY_HINTS: Record<PricingKnobRow["category"], string> = {
  feature_credits: "各生成モードで 1 回あたり消費するクレジット。Studio の表示と実際の課金の両方がこの値を読みます。",
  lora_formula: "消費クレジット = ceil(基本単価 × モデル係数 × 解像度係数 × バッチ係数 × Rank係数 × steps)。",
  cost_guard: "Next API がこの値からジョブの許容 GPU 秒を算出し、Modal ワーカーへ渡します（再デプロイ不要）。",
  rates: "損益計算と Cost Simulator の内部レート。クレジット単価はサブスク最安値と一致させること。",
};

const CATEGORY_ORDER: PricingKnobRow["category"][] = [
  "feature_credits",
  "lora_formula",
  "cost_guard",
  "rates",
];

function toEditableRow(pricing: StudioPricing): EditableRow {
  return {
    label: pricing.label,
    credits: String(pricing.credits),
    unit_cost_usd: String(pricing.unit_cost_usd),
  };
}

export function PricingTab() {
  const [pricing, setPricing] = useState<StudioPricing[]>([]);
  const [knobs, setKnobs] = useState<PricingKnobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, EditableRow>>({});
  const [knobDrafts, setKnobDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const [simFeatureKey, setSimFeatureKey] = useState<string>("");
  const [simSeconds, setSimSeconds] = useState("60");
  const [simExchangeRate, setSimExchangeRate] = useState("150");

  const knobValue = (key: string): number | undefined => {
    const row = knobs.find((k) => k.key === key);
    return row?.value;
  };
  const creditToJpy = knobValue("credit_to_jpy") ?? 1.66;

  const loadPricing = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/pricing");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      const rows = data.pricing as StudioPricing[];
      const knobRows = (data.knobs ?? []) as PricingKnobRow[];
      setPricing(rows);
      setKnobs(knobRows);
      setDrafts(Object.fromEntries(rows.map((r) => [r.key, toEditableRow(r)])));
      setKnobDrafts(Object.fromEntries(knobRows.map((k) => [k.key, String(k.value)])));
      if (rows.length > 0) setSimFeatureKey((prev) => prev || rows[0].key);
      const usdJpy = knobRows.find((k) => k.key === "usd_jpy_rate")?.value;
      if (usdJpy) setSimExchangeRate((prev) => (prev === "150" ? String(usdJpy) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPricing();
  }, []);

  const handleFieldChange = (key: string, field: keyof EditableRow, value: string) => {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  };

  const flashSaved = (key: string) => {
    setSavedKey(key);
    setTimeout(() => setSavedKey((cur) => (cur === key ? null : cur)), 1800);
  };

  const handleSave = async (key: string) => {
    const draft = drafts[key];
    if (!draft) return;

    const credits = Number(draft.credits);
    const unitCostUsd = Number(draft.unit_cost_usd);
    if (!Number.isFinite(credits) || !Number.isFinite(unitCostUsd)) {
      setError("消費クレジットとGPU秒単価は数値で入力してください。");
      return;
    }

    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch(`/api/admin/pricing/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: draft.label.trim(), credits, unit_cost_usd: unitCostUsd }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました。");

      const updated = data.pricing as StudioPricing;
      setPricing((prev) => prev.map((p) => (p.key === key ? updated : p)));
      setDrafts((prev) => ({ ...prev, [key]: toEditableRow(updated) }));
      flashSaved(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSavingKey(null);
    }
  };

  const handleKnobSave = async (key: string) => {
    const raw = knobDrafts[key];
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      setError("単価は 0 以上の数値で入力してください。");
      return;
    }

    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch(`/api/admin/pricing/knobs/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました。");

      const updated = data.knob as { key: string; value: number; updated_at: string };
      setKnobs((prev) =>
        prev.map((k) =>
          k.key === key ? { ...k, value: updated.value, updated_at: updated.updated_at, is_default: false } : k,
        ),
      );
      setKnobDrafts((prev) => ({ ...prev, [key]: String(updated.value) }));
      flashSaved(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSavingKey(null);
    }
  };

  const simFeature = pricing.find((p) => p.key === simFeatureKey) ?? null;

  const simResult = useMemo(() => {
    if (!simFeature) return null;
    const seconds = Number(simSeconds);
    const rate = Number(simExchangeRate);
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(rate) || rate <= 0) return null;

    const modalCostUsd = seconds * simFeature.unit_cost_usd;
    const modalCostJpy = modalCostUsd * rate;
    const revenueJpy = simFeature.credits * creditToJpy;
    const profitJpy = revenueJpy - modalCostJpy;
    const marginPercent = revenueJpy > 0 ? (profitJpy / revenueJpy) * 100 : 0;

    return { modalCostUsd, modalCostJpy, revenueJpy, profitJpy, marginPercent };
  }, [simFeature, simSeconds, simExchangeRate, creditToJpy]);

  const knobsByCategory = useMemo(() => {
    const map = new Map<PricingKnobRow["category"], PricingKnobRow[]>();
    for (const cat of CATEGORY_ORDER) map.set(cat, []);
    for (const k of knobs) map.get(k.category)?.push(k);
    return map;
  }, [knobs]);

  return (
    <div>
      <p className="mb-5 text-sm text-muted">
        全工程のクレジット単価・課金係数・損切り閾値をここで編集します。保存すると約1分以内に反映され、Modal
        の再デプロイは不要です。
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Loader2 size={18} className="animate-spin" />
          読み込み中...
        </div>
      ) : (
        <>
          {CATEGORY_ORDER.map((cat) => {
            const rows = knobsByCategory.get(cat) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={cat} className="mb-8">
                <h3 className="mb-1 text-sm font-semibold text-foreground">{CATEGORY_LABELS[cat]}</h3>
                <p className="mb-3 text-xs text-muted">{CATEGORY_HINTS[cat]}</p>
                <div className="overflow-x-auto rounded-2xl border border-border">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface/60 text-xs uppercase tracking-wide text-muted">
                        <th className="px-4 py-3 font-medium">項目</th>
                        <th className="px-4 py-3 font-medium">値</th>
                        <th className="px-4 py-3 font-medium text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr
                          key={row.key}
                          className="border-b border-border/60 last:border-0 hover:bg-surface-hover/40"
                        >
                          <td className="px-4 py-3">
                            <div className="font-medium text-foreground">
                              {row.label}
                              {row.is_default && (
                                <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted">
                                  既定値
                                </span>
                              )}
                            </div>
                            <div className="font-mono text-xs text-muted">{row.key}</div>
                            {row.description && (
                              <div className="mt-0.5 text-xs text-muted">{row.description}</div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                step="any"
                                value={knobDrafts[row.key] ?? String(row.value)}
                                onChange={(e) =>
                                  setKnobDrafts((prev) => ({ ...prev, [row.key]: e.target.value }))
                                }
                                className="w-28 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                              />
                              {row.unit && (
                                <span className="text-xs text-muted">{row.unit}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => handleKnobSave(row.key)}
                              disabled={savingKey === row.key}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:opacity-50"
                            >
                              {savingKey === row.key ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : savedKey === row.key ? (
                                <Check size={13} className="text-neon-pink" />
                              ) : (
                                <Save size={13} />
                              )}
                              {savedKey === row.key ? "保存済み" : "保存"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}

          <section className="mb-8">
            <h3 className="mb-1 text-sm font-semibold text-foreground">Wan Animate（旧 studio_pricing）</h3>
            <p className="mb-3 text-xs text-muted">
              Wan Animate 2 の各モードの消費クレジットと Modal GPU 秒単価(USD)。Cost Simulator の原価もここを参照します。
            </p>
            <div className="overflow-x-auto rounded-2xl border border-border">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface/60 text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-3 font-medium">機能</th>
                    <th className="px-4 py-3 font-medium">消費クレジット</th>
                    <th className="px-4 py-3 font-medium">GPU秒単価 (USD)</th>
                    <th className="px-4 py-3 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pricing.map((row) => {
                    const draft = drafts[row.key] ?? toEditableRow(row);
                    return (
                      <tr key={row.key} className="border-b border-border/60 last:border-0 hover:bg-surface-hover/40">
                        <td className="px-4 py-3">
                          <div className="font-medium text-foreground">{row.label}</div>
                          <div className="font-mono text-xs text-muted">{row.key}</div>
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            value={draft.credits}
                            onChange={(e) => handleFieldChange(row.key, "credits", e.target.value)}
                            className="w-24 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="number"
                            step="0.000001"
                            value={draft.unit_cost_usd}
                            onChange={(e) => handleFieldChange(row.key, "unit_cost_usd", e.target.value)}
                            className="w-32 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                          />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleSave(row.key)}
                            disabled={savingKey === row.key}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:opacity-50"
                          >
                            {savingKey === row.key ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : savedKey === row.key ? (
                              <Check size={13} className="text-neon-pink" />
                            ) : (
                              <Save size={13} />
                            )}
                            {savedKey === row.key ? "保存済み" : "保存"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="mt-8 rounded-2xl border-gradient bg-surface/40 p-6">
            <div className="mb-4 flex items-center gap-2 text-neon-pink">
              <Calculator size={16} />
              <span className="font-mono text-xs uppercase tracking-widest">Cost Simulator</span>
            </div>
            <p className="mb-4 text-xs text-muted">
              売上換算レート: 1 クレジット = ¥{creditToJpy}（credit_to_jpy）
            </p>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">対象機能</label>
                <select
                  value={simFeatureKey}
                  onChange={(e) => setSimFeatureKey(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                >
                  {pricing.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">想定推論時間（秒）</label>
                <input
                  type="number"
                  min={0}
                  value={simSeconds}
                  onChange={(e) => setSimSeconds(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">為替レート (USD/JPY)</label>
                <input
                  type="number"
                  min={0}
                  value={simExchangeRate}
                  onChange={(e) => setSimExchangeRate(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                />
              </div>
            </div>

            {simResult && simFeature && (
              <div className="mt-6 grid gap-3 sm:grid-cols-4">
                <SimCard label="Modal原価 (USD)" value={`$${simResult.modalCostUsd.toFixed(4)}`} />
                <SimCard label="Modal原価 (JPY)" value={`¥${simResult.modalCostJpy.toFixed(1)}`} />
                <SimCard label="クレジット売上 (JPY)" value={`¥${simResult.revenueJpy.toFixed(1)}`} />
                <SimCard
                  label="粗利率"
                  value={`${simResult.marginPercent.toFixed(1)}%`}
                  accent={simResult.marginPercent >= 0 ? "positive" : "negative"}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SimCard({ label, value, accent }: { label: string; value: string; accent?: "positive" | "negative" }) {
  return (
    <div className="rounded-xl border border-border bg-background/60 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div
        className={`mt-1 font-mono text-lg font-bold ${
          accent === "positive" ? "text-neon-pink" : accent === "negative" ? "text-red-400" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
