"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, Plus, Trash2 } from "lucide-react";
import {
  WORKFLOW_FIELD_TIERS,
  WORKFLOW_FIELD_TIER_LABELS,
  sortFieldsByOrder,
  type WorkflowFieldTier,
  type WorkflowInputField,
  type WorkflowSection,
} from "@/lib/customWorkflows";
import { COL_SPAN_OPTIONS, colSpanMdClass, fieldColSpan } from "@/lib/workflowLayout";
import { DynamicField, defaultValueFor, type FieldValue } from "@/components/studio/workflow/DynamicField";
import { WorkflowFieldLayout } from "@/components/studio/workflow/WorkflowFieldLayout";
import { UNSECTIONED, fieldBucket } from "@/components/admin/workflow-builder/builder";

const SECTION_DROP = "sectiondrop:";

export type PreviewMode = "desktop" | "mobile" | "preview";

function SortableFieldCard({
  field,
  value,
  selected,
  mobile,
  onSelect,
  onColSpan,
  onValueChange,
}: {
  field: WorkflowInputField;
  value: FieldValue;
  selected: boolean;
  mobile: boolean;
  onSelect: () => void;
  onColSpan: (span: (typeof COL_SPAN_OPTIONS)[number]["value"]) => void;
  onValueChange: (v: FieldValue) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  const spanClass = mobile ? "md:col-span-12" : colSpanMdClass(fieldColSpan(field));

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`col-span-1 ${spanClass} ${isDragging ? "opacity-50" : ""}`}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => (e.key === "Enter" ? onSelect() : undefined)}
        className={`rounded-xl border p-2.5 transition-colors ${
          selected ? "border-neon-pink/60 bg-neon-pink/5" : "border-border bg-background hover:border-neon-violet/40"
        }`}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="shrink-0 cursor-grab text-muted active:cursor-grabbing"
              {...attributes}
              {...listeners}
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical size={13} />
            </button>
            <span className="truncate text-[11px] font-medium text-foreground">{field.label || field.id}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {field.minTier && (
              <span className="rounded bg-neon-pink px-1 text-[8px] font-semibold text-white">
                🔒 {WORKFLOW_FIELD_TIER_LABELS[field.minTier]}
              </span>
            )}
            <span className="font-mono text-[9px] text-muted">{field.type}</span>
          </span>
        </div>

        <div className="mb-1.5 flex gap-0.5">
          {COL_SPAN_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onColSpan(opt.value);
              }}
              className={`flex-1 rounded border px-0.5 py-0.5 text-[8px] font-medium transition-colors ${
                fieldColSpan(field) === opt.value
                  ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <DynamicField field={field} value={value} onChange={onValueChange} />
        {Boolean(field.credits_add) && (
          <p className="mt-1 font-mono text-[9px] text-neon-pink">+{field.credits_add}C</p>
        )}
      </div>
    </div>
  );
}

function SectionBand({
  section,
  fields,
  selectedId,
  mobile,
  previewValues,
  onSelect,
  onFieldPatch,
  onPreviewValue,
  onRemove,
  onSectionPatch,
}: {
  section: WorkflowSection | null;
  fields: WorkflowInputField[];
  selectedId: string | null;
  mobile: boolean;
  previewValues: Record<string, FieldValue>;
  onSelect: (id: string | null) => void;
  onFieldPatch: (id: string, patch: Partial<WorkflowInputField>) => void;
  onPreviewValue: (id: string, v: FieldValue) => void;
  onRemove?: () => void;
  onSectionPatch?: (patch: Partial<WorkflowSection>) => void;
}) {
  const bid = section ? section.id : UNSECTIONED;
  const { setNodeRef, isOver } = useDroppable({ id: `${SECTION_DROP}${bid}` });
  const [open, setOpen] = useState(section ? !section.defaultCollapsed : true);

  return (
    <div
      ref={setNodeRef}
      className={`rounded-xl border transition-colors ${
        isOver ? "border-neon-pink/60 bg-neon-pink/5" : "border-border/70 bg-surface/20"
      }`}
    >
      <div className="flex items-center justify-between gap-2 p-2.5">
        {section ? (
          <input
            value={section.label}
            onChange={(e) => onSectionPatch?.({ label: e.target.value })}
            className="w-full bg-transparent text-[11px] font-semibold text-neon-violet outline-none"
          />
        ) : (
          <span className="text-[11px] font-semibold text-muted">（セクション未指定）</span>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {section && onSectionPatch && (
            <>
              <select
                value={section.minTier ?? ""}
                onChange={(e) =>
                  onSectionPatch({ minTier: (e.target.value || undefined) as WorkflowFieldTier | undefined })
                }
                title="このセクションの MinTier"
                className="rounded border border-border bg-background px-1 py-0.5 text-[9px] outline-none"
              >
                <option value="">Tier制限なし</option>
                {WORKFLOW_FIELD_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {WORKFLOW_FIELD_TIER_LABELS[t]}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-0.5 text-[9px] text-muted">
                <input
                  type="checkbox"
                  checked={Boolean(section.defaultCollapsed)}
                  onChange={(e) => onSectionPatch({ defaultCollapsed: e.target.checked })}
                  className="h-3 w-3 accent-neon-pink"
                />
                既定で折りたたむ
              </label>
            </>
          )}
          {section && onRemove && (
            <button type="button" onClick={onRemove} className="text-muted hover:text-red-400">
              <Trash2 size={12} />
            </button>
          )}
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-muted">
            <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {open && (
        <div className="grid min-h-[52px] grid-cols-1 gap-3 border-t border-border/60 p-2.5 md:grid-cols-12">
          {fields.length === 0 ? (
            <p className="col-span-1 flex items-center justify-center rounded-lg border border-dashed border-border py-4 text-center text-[10px] text-muted md:col-span-12">
              ここにフィールドをドラッグ
            </p>
          ) : (
            fields.map((field) => (
              <SortableFieldCard
                key={field.id}
                field={field}
                value={previewValues[field.id] ?? defaultValueFor(field)}
                selected={selectedId === field.id}
                mobile={mobile}
                onSelect={() => onSelect(field.id)}
                onColSpan={(span) => onFieldPatch(field.id, { colSpan: span })}
                onValueChange={(v) => onPreviewValue(field.id, v)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Center pane (45%): live 12-col canvas. Editable (drag reorder, colSpan
// snap, sections) or, in "preview" mode, the exact <WorkflowFieldLayout>
// the Studio uses — a true WYSIWYG check.
export function LiveCanvasPane({
  fields,
  sections,
  selectedId,
  previewMode,
  previewTier,
  previewValues,
  onSelect,
  onReorder,
  onFieldPatch,
  onAddSection,
  onRemoveSection,
  onSectionPatch,
  onPreviewValue,
}: {
  fields: WorkflowInputField[];
  sections: WorkflowSection[];
  selectedId: string | null;
  previewMode: PreviewMode;
  previewTier: string;
  previewValues: Record<string, FieldValue>;
  onSelect: (id: string | null) => void;
  onReorder: (activeId: string, overId: string, targetSectionId: string | undefined) => void;
  onFieldPatch: (id: string, patch: Partial<WorkflowInputField>) => void;
  onAddSection: () => void;
  onRemoveSection: (id: string) => void;
  onSectionPatch: (id: string, patch: Partial<WorkflowSection>) => void;
  onPreviewValue: (id: string, v: FieldValue) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const mobile = previewMode === "mobile";

  const ordered = useMemo(() => sortFieldsByOrder(fields), [fields]);
  const buckets = useMemo(() => {
    const map = new Map<string, WorkflowInputField[]>();
    map.set(UNSECTIONED, []);
    for (const s of sections) map.set(s.id, []);
    for (const f of ordered) {
      const b = fieldBucket(f);
      if (!map.has(b)) map.set(b, []);
      map.get(b)!.push(f);
    }
    return map;
  }, [ordered, sections]);

  const handleDragEnd = (e: DragEndEvent) => {
    const activeId = String(e.active.id);
    if (!e.over) return;
    const overId = String(e.over.id);
    if (overId === activeId) return;
    if (overId.startsWith(SECTION_DROP)) {
      const target = overId.slice(SECTION_DROP.length);
      onReorder(activeId, activeId, target === UNSECTIONED ? undefined : target);
      return;
    }
    const overField = fields.find((f) => f.id === overId);
    onReorder(activeId, overId, overField ? overField.sectionId : undefined);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neon-violet">
          {previewMode === "preview" ? "プレビュー（ユーザー画面と一致）" : "ライブキャンバス"}
        </h2>
        {previewMode !== "preview" && (
          <button
            type="button"
            onClick={onAddSection}
            className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[10px] text-muted hover:text-foreground"
          >
            <Plus size={10} />
            セクション追加
          </button>
        )}
      </div>

      <div
        className={`flex-1 overflow-y-auto p-4 ${mobile || previewMode === "preview" ? "" : ""}`}
        onClick={() => onSelect(null)}
      >
        {previewMode === "preview" ? (
          <div className={mobile ? "mx-auto w-full max-w-[420px]" : ""} onClick={(e) => e.stopPropagation()}>
            <WorkflowFieldLayout
              fields={fields}
              sections={sections}
              values={previewValues}
              userTier={previewTier}
              onChange={onPreviewValue}
              onLockedInteract={() => undefined}
            />
          </div>
        ) : fields.length === 0 && sections.length === 0 ? (
          <p className="py-16 text-center text-[11px] text-muted">
            左のノードツリーから入力を「UIに公開」すると、ここに追加されます。
          </p>
        ) : (
          <div className={`space-y-3 ${mobile ? "mx-auto w-full max-w-[420px]" : ""}`} onClick={(e) => e.stopPropagation()}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={ordered.map((f) => f.id)} strategy={rectSortingStrategy}>
                <SectionBand
                  section={null}
                  fields={buckets.get(UNSECTIONED) ?? []}
                  selectedId={selectedId}
                  mobile={mobile}
                  previewValues={previewValues}
                  onSelect={onSelect}
                  onFieldPatch={onFieldPatch}
                  onPreviewValue={onPreviewValue}
                />
                {sections.map((s) => (
                  <SectionBand
                    key={s.id}
                    section={s}
                    fields={buckets.get(s.id) ?? []}
                    selectedId={selectedId}
                    mobile={mobile}
                    previewValues={previewValues}
                    onSelect={onSelect}
                    onFieldPatch={onFieldPatch}
                    onPreviewValue={onPreviewValue}
                    onRemove={() => onRemoveSection(s.id)}
                    onSectionPatch={(patch) => onSectionPatch(s.id, patch)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}
      </div>
    </div>
  );
}
