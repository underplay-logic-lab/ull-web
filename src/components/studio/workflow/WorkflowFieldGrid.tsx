"use client";

import { useMemo } from "react";
import {
  WORKFLOW_FIELD_TIER_LABELS,
  fieldAppliesCreditsAdd,
  isTierLocked,
  type WorkflowInputField,
} from "@/lib/customWorkflows";
import { colSpanMdClass, fieldColSpan } from "@/lib/workflowLayout";
import { defaultValueFor, FieldRow, type FieldValue } from "./DynamicField";

// 12-column responsive form grid shared by the Studio renderer and the
// UI builder's live canvas. Each field takes `md:col-span-{3|4|6|12}` from
// its `colSpan` (undefined → full width); below the `md` breakpoint every
// field is full width via `grid-cols-1`.
//
// Perf: FieldRow / DynamicField are memoized, so the per-field onChange
// handlers must be referentially stable — callers pass a stable `onChange`
// (useCallback) and a stable `fields` ref (useMemo).
export function WorkflowFieldGrid({
  fields,
  values,
  onChange,
  userTier,
  onLockedInteract,
}: {
  fields: WorkflowInputField[];
  values: Record<string, FieldValue>;
  onChange: (fieldId: string, value: FieldValue) => void;
  // Viewer's subscription tier — fields gated above it are locked. Undefined
  // (the builder canvas) = nothing is locked.
  userTier?: string | null;
  onLockedInteract?: () => void;
}) {
  const handlers = useMemo(() => {
    const map = new Map<string, (v: FieldValue) => void>();
    for (const f of fields) {
      map.set(f.id, (v: FieldValue) => onChange(f.id, v));
    }
    return map;
  }, [fields, onChange]);

  if (fields.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
      {fields.map((field) => {
        const value = values[field.id] ?? defaultValueFor(field);
        const locked = userTier !== undefined && isTierLocked(field.minTier, userTier);
        return (
          <div key={field.id} className={`col-span-1 ${colSpanMdClass(fieldColSpan(field))}`}>
            {locked ? (
              <div
                role="button"
                tabIndex={0}
                onClick={onLockedInteract}
                onKeyDown={(e) => (e.key === "Enter" ? onLockedInteract?.() : undefined)}
                className="relative cursor-pointer rounded-lg border border-dashed border-neon-pink/40 p-3"
              >
                <span className="absolute -top-2 right-2 rounded-full bg-neon-pink px-2 py-0.5 text-[9px] font-semibold text-white">
                  🔒 {WORKFLOW_FIELD_TIER_LABELS[field.minTier!]} 限定
                </span>
                <div className="pointer-events-none opacity-50">
                  <FieldRow
                    field={field}
                    value={value}
                    applied={false}
                    onChange={handlers.get(field.id)!}
                  />
                </div>
              </div>
            ) : (
              <FieldRow
                field={field}
                value={value}
                applied={fieldAppliesCreditsAdd(field, value)}
                onChange={handlers.get(field.id)!}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
