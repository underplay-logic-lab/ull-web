"use client";

import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import type { StudioPreset } from "./types";

type PresetFormValues = {
  title: string;
  category: string;
  video_url: string;
  thumbnail_url: string;
  priority: number;
  is_active: boolean;
};

type PresetModalProps = {
  preset: StudioPreset | null;
  onClose: () => void;
  onSaved: (preset: StudioPreset) => void;
};

function toFormValues(preset: StudioPreset | null): PresetFormValues {
  if (!preset) {
    return { title: "", category: "", video_url: "", thumbnail_url: "", priority: 0, is_active: true };
  }
  return {
    title: preset.title,
    category: preset.category,
    video_url: preset.video_url,
    thumbnail_url: preset.thumbnail_url ?? "",
    priority: preset.priority,
    is_active: preset.is_active,
  };
}

export function PresetModal({ preset, onClose, onSaved }: PresetModalProps) {
  const [values, setValues] = useState<PresetFormValues>(() => toFormValues(preset));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = preset !== null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!values.title.trim() || !values.category.trim() || !values.video_url.trim()) {
      setError("タイトル・カテゴリ・動画URLは必須です。");
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        title: values.title.trim(),
        category: values.category.trim(),
        video_url: values.video_url.trim(),
        thumbnail_url: values.thumbnail_url.trim() || null,
        priority: values.priority,
        is_active: values.is_active,
      };

      const res = await fetch(isEdit ? `/api/admin/presets/${preset!.id}` : "/api/admin/presets", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error ?? "保存に失敗しました。");
      }

      onSaved(data.preset as StudioPreset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border-gradient bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-foreground">
            {isEdit ? "プリセットを編集" : "プリセットを新規追加"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-muted transition-colors hover:text-foreground"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">タイトル</label>
            <input
              value={values.title}
              onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))}
              className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
              placeholder="例: 手を振る"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">カテゴリ</label>
            <input
              value={values.category}
              onChange={(e) => setValues((v) => ({ ...v, category: e.target.value }))}
              className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
              placeholder="例: greeting"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">動画URL</label>
            <input
              value={values.video_url}
              onChange={(e) => setValues((v) => ({ ...v, video_url: e.target.value }))}
              className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
              placeholder="/motion-presets/wave.mp4"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">サムネイルURL（任意）</label>
            <input
              value={values.thumbnail_url}
              onChange={(e) => setValues((v) => ({ ...v, thumbnail_url: e.target.value }))}
              className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
              placeholder="/motion-presets/wave-thumb.jpg"
            />
          </div>

          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1.5 block text-xs font-medium text-muted">表示優先度</label>
              <input
                type="number"
                value={values.priority}
                onChange={(e) => setValues((v) => ({ ...v, priority: Number(e.target.value) || 0 }))}
                className="w-full rounded-lg border border-border bg-background px-3.5 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
              />
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-xs font-medium text-muted">
              <input
                type="checkbox"
                checked={values.is_active}
                onChange={(e) => setValues((v) => ({ ...v, is_active: e.target.checked }))}
                className="h-4 w-4 rounded border-border bg-background accent-neon-pink"
              />
              有効
            </label>
          </div>

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {isEdit ? "変更を保存" : "プリセットを作成"}
          </button>
        </form>
      </div>
    </div>,
    document.body,
  );
}
