"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Film, ImagePlus, RefreshCw, Trash2, X } from "lucide-react";
import type { WorkflowInputField } from "@/lib/customWorkflows";

// A single dynamic-form value. File covers image/video uploads; null is the
// "not yet provided" state for those. Extracted from
// src/components/studio/CustomWorkflowsTab.tsx so the Studio renderer and
// the UI builder's live canvas render the exact same components.
export type FieldValue = string | number | boolean | File | null;

// Dropzone height for image/video fields — matches the presets offered in
// the builder's inspector. Undefined keeps the original 160px minimum.
function heightPresetClass(preset: WorkflowInputField["heightPreset"]): string {
  switch (preset) {
    case "compact":
      return "min-h-[120px]";
    case "large":
      return "min-h-[320px]";
    case "square":
      return "aspect-square min-h-[200px]";
    case "standard":
      return "min-h-[200px]";
    default:
      return "min-h-[160px]";
  }
}

export function defaultValueFor(field: WorkflowInputField): FieldValue {
  if (field.type === "image" || field.type === "video") return null;
  if (field.type === "toggle") return typeof field.default === "boolean" ? field.default : false;
  if (field.type === "slider") {
    if (typeof field.default === "number") return field.default;
    return field.min ?? 0;
  }
  if (field.type === "select") {
    if (field.default !== undefined && typeof field.default !== "boolean") return String(field.default);
    return field.options?.[0] !== undefined ? String(field.options[0].value) : "";
  }
  return typeof field.default === "string" ? field.default : "";
}

function ImageDropzone({
  file,
  onFileSelected,
  onClear,
  heightClass,
}: {
  file: File | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
  heightClass: string;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (picked) onFileSelected(picked);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`relative flex ${heightClass} cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed p-4 text-center transition-colors ${
          isDragging ? "border-neon-pink/70 bg-neon-pink/10" : "border-border bg-background hover:border-neon-violet/40"
        }`}
      >
        {previewUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt={file?.name ?? "アップロード画像"} className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              aria-label="削除"
              className="absolute right-2 top-2 z-10 rounded-full bg-black/60 p-1.5 text-white transition-colors hover:bg-black/80"
            >
              <X size={14} />
            </button>
            <span className="relative z-10 mt-auto max-w-full truncate rounded-md bg-black/60 px-2 py-1 text-[11px] text-white">
              {file?.name}
            </span>
          </>
        ) : (
          <>
            <ImagePlus size={24} className="text-muted" />
            <p className="text-xs text-muted">ドラッグ＆ドロップ、またはクリックして選択</p>
          </>
        )}
      </div>
    </div>
  );
}

const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm";

function VideoDropzone({
  file,
  onFileSelected,
  onClear,
  heightClass,
}: {
  file: File | null;
  onFileSelected: (file: File) => void;
  onClear: () => void;
  heightClass: string;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFiles = (files: FileList | null) => {
    const picked = files?.[0];
    if (picked) onFileSelected(picked);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {file && previewUrl ? (
        <div className="rounded-xl border border-border bg-background p-2">
          {/* Immediate inline playback preview of the selected video. */}
          <video controls src={previewUrl} className="max-h-56 w-full rounded-lg bg-black" />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{file.name}</span>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
              >
                <RefreshCw size={11} />
                選び直す
              </button>
              <button
                type="button"
                onClick={onClear}
                className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red-400/50 hover:text-red-400"
              >
                <Trash2 size={11} />
                削除
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`flex ${heightClass} cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-center transition-colors ${
            isDragging ? "border-neon-pink/70 bg-neon-pink/10" : "border-border bg-background hover:border-neon-violet/40"
          }`}
        >
          <Film size={24} className="text-muted" />
          <p className="text-xs text-muted">ドラッグ＆ドロップ、またはクリックして選択</p>
          <p className="text-[10px] text-muted/70">MP4 / MOV / WebM</p>
        </div>
      )}
    </div>
  );
}

// Range input with local state + one-per-frame parent commit. A slider drag
// fires dozens of onChange events; without this each one re-rendered the
// whole Studio tab (credit recompute, every other field, dropzone previews),
// which is what made the seconds slider feel laggy. Local state paints the
// thumb/number instantly; the parent (and therefore the live credit total)
// is updated at most once per animation frame.
const SliderControl = memo(function SliderControl({
  min,
  max,
  step,
  value,
  onCommit,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  const raf = useRef<number | null>(null);

  // Adopt external changes only when we're not the one driving them.
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const scheduleCommit = (v: number) => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      onCommit(v);
    });
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
        <span>{min}</span>
        <span className="font-mono text-foreground">{local}</span>
        <span>{max}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          scheduleCommit(v);
        }}
        className="w-full accent-neon-pink"
      />
    </div>
  );
});

export const DynamicField = memo(function DynamicField({
  field,
  value,
  onChange,
}: {
  field: WorkflowInputField;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
}) {
  if (field.type === "image") {
    return (
      <ImageDropzone
        file={value instanceof File ? value : null}
        onFileSelected={onChange}
        onClear={() => onChange(null)}
        heightClass={heightPresetClass(field.heightPreset)}
      />
    );
  }

  if (field.type === "video") {
    return (
      <VideoDropzone
        file={value instanceof File ? value : null}
        onFileSelected={onChange}
        onClear={() => onChange(null)}
        heightClass={heightPresetClass(field.heightPreset)}
      />
    );
  }

  if (field.type === "slider") {
    const min = field.min ?? 0;
    const max = field.max ?? 1;
    const step = field.step ?? 0.01;
    const numeric = typeof value === "number" ? value : min;
    return <SliderControl min={min} max={max} step={step} value={numeric} onCommit={onChange} />;
  }

  if (field.type === "select") {
    const options = field.options ?? [];
    const current = value === undefined || value === null ? "" : String(value);
    return (
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
      >
        {options.length === 0 && <option value="">（選択肢が未設定です）</option>}
        {options.map((opt) => (
          <option key={String(opt.value)} value={String(opt.value)}>
            {opt.label}
            {opt.credits_add ? `（${opt.is_base_override ? "" : "+"}${opt.credits_add}C）` : ""}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "toggle") {
    const checked = value === true;
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
          checked ? "border-neon-pink/50 bg-neon-pink/10 text-neon-pink" : "border-border bg-background text-muted"
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${checked ? "bg-neon-pink" : "bg-muted"}`} />
        {checked ? "ON" : "OFF"}
      </button>
    );
  }

  return (
    <textarea
      rows={typeof field.rows === "number" && field.rows > 0 ? field.rows : 3}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-lg border border-border bg-background px-4 py-3 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
    />
  );
});

export const FieldRow = memo(function FieldRow({
  field,
  value,
  applied,
  onChange,
}: {
  field: WorkflowInputField;
  value: FieldValue;
  applied: boolean;
  onChange: (value: FieldValue) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <label className="text-xs font-medium text-muted">{field.label}</label>
        {Boolean(field.credits_add) && (
          <span
            className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
              applied ? "bg-neon-pink/20 text-neon-pink" : "bg-border text-muted"
            }`}
          >
            +{field.credits_add}C
          </span>
        )}
      </div>
      <DynamicField field={field} value={value} onChange={onChange} />
    </div>
  );
});
