// 12-column grid layout helpers for the dynamic workflow form — shared by
// the Studio renderer (WorkflowFieldGrid) and the Phase 2 builder canvas.
// No "server-only" guard, pure functions.

import {
  sortFieldsByOrder,
  type WorkflowFieldColSpan,
  type WorkflowInputField,
} from "@/lib/customWorkflows";

export const DEFAULT_COL_SPAN: WorkflowFieldColSpan = 12;

// The four spans an admin can pick in the builder, with their fraction label
// and the exact Tailwind class each maps to. The class strings are written
// out in full (never `md:col-span-${n}`) so Tailwind's JIT keeps them.
export const COL_SPAN_OPTIONS: {
  value: WorkflowFieldColSpan;
  label: string;
  fraction: string;
  mdClass: string;
}[] = [
  { value: 3, label: "1/4", fraction: "¼", mdClass: "md:col-span-3" },
  { value: 4, label: "1/3", fraction: "⅓", mdClass: "md:col-span-4" },
  { value: 6, label: "1/2", fraction: "½", mdClass: "md:col-span-6" },
  { value: 12, label: "全幅", fraction: "1", mdClass: "md:col-span-12" },
];

export function fieldColSpan(field: WorkflowInputField): WorkflowFieldColSpan {
  return field.colSpan ?? DEFAULT_COL_SPAN;
}

// Tailwind md-breakpoint column-span class for a span value. Mobile is
// always a single column (`grid-cols-1`), so callers only need the md class.
export function colSpanMdClass(span: WorkflowFieldColSpan): string {
  switch (span) {
    case 3:
      return "md:col-span-3";
    case 4:
      return "md:col-span-4";
    case 6:
      return "md:col-span-6";
    default:
      return "md:col-span-12";
  }
}

export type WorkflowFieldGridRow = {
  row: number;
  fields: WorkflowInputField[];
};

// Groups fields into 12-wide rows for the builder canvas (the Studio
// renderer leans on CSS grid auto-flow instead and doesn't need this).
//
// Rules, in order of precedence:
//   1. A field with an explicit `row` number joins that row.
//   2. Remaining fields flow in `order` sequence, greedily packed: a field
//      starts a new row whenever adding its colSpan would exceed 12.
// Rows are returned sorted by row number; field order within a row follows
// sortFieldsByOrder().
export function groupFieldsIntoGrid(fields: WorkflowInputField[]): WorkflowFieldGridRow[] {
  const ordered = sortFieldsByOrder(fields);

  const explicitRows = new Map<number, WorkflowInputField[]>();
  const flowing: WorkflowInputField[] = [];

  for (const field of ordered) {
    if (typeof field.row === "number") {
      const bucket = explicitRows.get(field.row) ?? [];
      bucket.push(field);
      explicitRows.set(field.row, bucket);
    } else {
      flowing.push(field);
    }
  }

  // Auto-assign flowing fields to synthetic rows starting after the highest
  // explicit row, packing greedily by colSpan.
  const maxExplicitRow = explicitRows.size > 0 ? Math.max(...explicitRows.keys()) : -1;
  let autoRow = maxExplicitRow + 1;
  let widthInRow = 0;

  for (const field of flowing) {
    const span = fieldColSpan(field);
    if (widthInRow > 0 && widthInRow + span > 12) {
      autoRow += 1;
      widthInRow = 0;
    }
    const bucket = explicitRows.get(autoRow) ?? [];
    bucket.push(field);
    explicitRows.set(autoRow, bucket);
    widthInRow += span;
    if (widthInRow >= 12) {
      autoRow += 1;
      widthInRow = 0;
    }
  }

  return [...explicitRows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([row, rowFields]) => ({ row, fields: sortFieldsByOrder(rowFields) }));
}
