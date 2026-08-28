"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Lock, Settings2 } from "lucide-react";
import {
  WORKFLOW_FIELD_TIER_LABELS,
  isTierLocked,
  sortFieldsByOrder,
  type WorkflowInputField,
  type WorkflowSection,
} from "@/lib/customWorkflows";
import { WorkflowFieldGrid } from "./WorkflowFieldGrid";
import { type FieldValue } from "./DynamicField";

// The canonical Studio renderer for a workflow's dynamic form — sections,
// accordions, 12-col grid, and minTier locks. The builder's Live Canvas is
// laid out to match this exactly, and its "プレビュー" mode renders this
// component directly, so what the admin lays out is what the user sees.
export function WorkflowFieldLayout({
  fields,
  sections,
  values,
  userTier,
  onChange,
  onLockedInteract,
}: {
  fields: WorkflowInputField[];
  sections: WorkflowSection[];
  values: Record<string, FieldValue>;
  userTier?: string | null;
  onChange: (fieldId: string, value: FieldValue) => void;
  onLockedInteract?: () => void;
}) {
  const { baseFields, sectionFieldMap, advancedFields } = useMemo(() => {
    const map = new Map<string, WorkflowInputField[]>();
    const base: WorkflowInputField[] = [];
    const advanced: WorkflowInputField[] = [];
    const sectionIds = new Set(sections.map((s) => s.id));
    for (const f of fields) {
      if (f.sectionId && sectionIds.has(f.sectionId)) {
        const arr = map.get(f.sectionId) ?? [];
        arr.push(f);
        map.set(f.sectionId, arr);
      } else if (f.section === "advanced") {
        advanced.push(f);
      } else {
        base.push(f);
      }
    }
    for (const [k, v] of map) map.set(k, sortFieldsByOrder(v));
    return {
      baseFields: sortFieldsByOrder(base),
      sectionFieldMap: map,
      advancedFields: sortFieldsByOrder(advanced),
    };
  }, [fields, sections]);

  // Per-section open/closed — seeded from defaultCollapsed.
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.map((s) => [s.id, !s.defaultCollapsed])),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const gridProps = { values, onChange, userTier, onLockedInteract };

  return (
    <div className="flex flex-col gap-5">
      {/* Base band */}
      {baseFields.length > 0 &&
        (sections.length > 0 ? (
          <div className="rounded-xl border border-border/70 bg-surface/20 p-4">
            <p className="mb-3 text-xs font-semibold text-neon-violet">基本設定</p>
            <WorkflowFieldGrid fields={baseFields} {...gridProps} />
          </div>
        ) : (
          <WorkflowFieldGrid fields={baseFields} {...gridProps} />
        ))}

      {/* Named sections */}
      {sections.map((section) => {
        const sf = sectionFieldMap.get(section.id) ?? [];
        if (sf.length === 0) return null;
        const locked = userTier !== undefined && isTierLocked(section.minTier, userTier);
        const isOpen = open[section.id] ?? true;
        return (
          <div key={section.id} className="rounded-xl border border-border/70 bg-surface/20">
            <button
              type="button"
              onClick={() => (locked ? onLockedInteract?.() : setOpen((p) => ({ ...p, [section.id]: !isOpen })))}
              className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-semibold text-neon-violet">{section.label}</span>
                {locked && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-neon-pink px-2 py-0.5 text-[9px] font-semibold text-white">
                    <Lock size={8} />
                    {WORKFLOW_FIELD_TIER_LABELS[section.minTier!]} 限定
                  </span>
                )}
              </span>
              <ChevronDown
                size={14}
                className={`shrink-0 text-muted transition-transform ${isOpen && !locked ? "rotate-180" : ""}`}
              />
            </button>
            {isOpen && !locked && (
              <div className="border-t border-border/70 p-4">
                {section.description && (
                  <p className="mb-3 text-[11px] leading-relaxed text-muted">{section.description}</p>
                )}
                <WorkflowFieldGrid fields={sf} {...gridProps} />
              </div>
            )}
          </div>
        );
      })}

      {/* Legacy "advanced" accordion */}
      {advancedFields.length > 0 && (
        <div className="rounded-xl border border-border">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-xs font-medium text-muted transition-colors hover:text-foreground"
          >
            <span className="flex items-center gap-1.5">
              <Settings2 size={14} />
              詳細設定
            </span>
            <ChevronDown size={14} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
          </button>
          {advancedOpen && (
            <div className="border-t border-border p-4">
              <WorkflowFieldGrid fields={advancedFields} {...gridProps} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
