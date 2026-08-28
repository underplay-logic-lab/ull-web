"use client";

import { fieldAppliesCreditsAdd, type WorkflowInputField } from "@/lib/customWorkflows";
import { colSpanMdClass, fieldColSpan } from "@/lib/workflowLayout";
import { defaultValueFor, FieldRow, type FieldValue } from "./DynamicField";

// 12-column responsive form grid shared by the Studio renderer and the
// UI builder's live canvas. Each field takes `md:col-span-{3|4|6|12}` from
// its `colSpan` (undefined → full width); below the `md` breakpoint every
// field is full width via `grid-cols-1`.
export function WorkflowFieldGrid({
  fields,
  values,
  onChange,
}: {
  fields: WorkflowInputField[];
  values: Record<string, FieldValue>;
  onChange: (fieldId: string, value: FieldValue) => void;
}) {
  if (fields.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
      {fields.map((field) => {
        const value = values[field.id] ?? defaultValueFor(field);
        return (
          <div key={field.id} className={`col-span-1 ${colSpanMdClass(fieldColSpan(field))}`}>
            <FieldRow
              field={field}
              value={value}
              applied={fieldAppliesCreditsAdd(field, value)}
              onChange={(next) => onChange(field.id, next)}
            />
          </div>
        );
      })}
    </div>
  );
}
