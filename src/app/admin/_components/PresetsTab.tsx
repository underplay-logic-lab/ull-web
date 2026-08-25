"use client";

import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, ToggleLeft, ToggleRight, Video } from "lucide-react";
import { PresetModal } from "./PresetModal";
import type { StudioPreset } from "./types";

export function PresetsTab() {
  const [presets, setPresets] = useState<StudioPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalState, setModalState] = useState<{ open: boolean; preset: StudioPreset | null }>({
    open: false,
    preset: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadPresets = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/presets");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      setPresets(data.presets as StudioPreset[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPresets();
  }, []);

  const handleToggleActive = async (preset: StudioPreset) => {
    setBusyId(preset.id);
    try {
      const res = await fetch(`/api/admin/presets/${preset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !preset.is_active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "更新に失敗しました。");
      setPresets((prev) => prev.map((p) => (p.id === preset.id ? (data.preset as StudioPreset) : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました。");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (preset: StudioPreset) => {
    if (!window.confirm(`「${preset.title}」を削除しますか？`)) return;
    setBusyId(preset.id);
    try {
      const res = await fetch(`/api/admin/presets/${preset.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "削除に失敗しました。");
      setPresets((prev) => prev.filter((p) => p.id !== preset.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setBusyId(null);
    }
  };

  const handleSaved = (preset: StudioPreset) => {
    setPresets((prev) => {
      const exists = prev.some((p) => p.id === preset.id);
      const next = exists ? prev.map((p) => (p.id === preset.id ? preset : p)) : [...prev, preset];
      return next.sort((a, b) => b.priority - a.priority);
    });
    setModalState({ open: false, preset: null });
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-muted">
          Studio に表示するモーション/スタイルプリセットの管理台帳です。
        </p>
        <button
          type="button"
          onClick={() => setModalState({ open: true, preset: null })}
          className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Plus size={14} />
          新規追加
        </button>
      </div>

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
      ) : presets.length === 0 ? (
        <div className="rounded-2xl border-gradient bg-surface/40 px-6 py-16 text-center text-sm text-muted">
          プリセットがまだ登録されていません。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface/60 text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">タイトル</th>
                <th className="px-4 py-3 font-medium">カテゴリ</th>
                <th className="px-4 py-3 font-medium">動画URL</th>
                <th className="px-4 py-3 font-medium">優先度</th>
                <th className="px-4 py-3 font-medium">状態</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {presets.map((preset) => (
                <tr key={preset.id} className="border-b border-border/60 last:border-0 hover:bg-surface-hover/40">
                  <td className="px-4 py-3 font-medium text-foreground">{preset.title}</td>
                  <td className="px-4 py-3 text-muted">{preset.category}</td>
                  <td className="max-w-[220px] truncate px-4 py-3 text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <Video size={13} className="shrink-0 text-neon-violet" />
                      <span className="truncate font-mono text-xs">{preset.video_url}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted">{preset.priority}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(preset)}
                      disabled={busyId === preset.id}
                      className={`flex items-center gap-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        preset.is_active ? "text-neon-pink" : "text-muted"
                      }`}
                    >
                      {preset.is_active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      {preset.is_active ? "有効" : "無効"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => setModalState({ open: true, preset })}
                        aria-label="編集"
                        className="text-muted transition-colors hover:text-neon-violet"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(preset)}
                        disabled={busyId === preset.id}
                        aria-label="削除"
                        className="text-muted transition-colors hover:text-red-400 disabled:opacity-50"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalState.open && (
        <PresetModal
          preset={modalState.preset}
          onClose={() => setModalState({ open: false, preset: null })}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
