"use client";

import { useEffect, useState } from "react";
import { Clipboard, Download, Loader2, Pencil, Plus, Trash2, ToggleLeft, ToggleRight, Workflow } from "lucide-react";
import { CustomWorkflowModal } from "./CustomWorkflowModal";
import { ToastStack, type ToastData } from "@/components/Toast";
import { downloadJson } from "@/lib/downloadJson";
import type { StudioCustomWorkflow } from "./types";

export function CustomWorkflowsTab() {
  const [workflows, setWorkflows] = useState<StudioCustomWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalState, setModalState] = useState<{ open: boolean; workflow: StudioCustomWorkflow | null }>({
    open: false,
    workflow: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const handleCopyJson = async (workflow: StudioCustomWorkflow) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(workflow.workflow_json, null, 2));
      setToasts((prev) => [...prev, { id: Date.now(), message: "ワークフローJSONをコピーしました" }]);
    } catch (err) {
      setToasts((prev) => [
        ...prev,
        { id: Date.now(), message: `コピーに失敗しました: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    }
  };

  const handleDownloadJson = (workflow: StudioCustomWorkflow) => {
    const filename = `${workflow.slug || "workflow"}_api.json`;
    downloadJson(workflow.workflow_json, filename);
    setToasts((prev) => [...prev, { id: Date.now(), message: `${filename} をダウンロードしました` }]);
  };

  const loadWorkflows = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/custom-workflows");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      setWorkflows(data.workflows as StudioCustomWorkflow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkflows();
  }, []);

  const handleToggleActive = async (workflow: StudioCustomWorkflow) => {
    setBusyId(workflow.id);
    try {
      const res = await fetch(`/api/admin/custom-workflows/${workflow.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !workflow.is_active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "更新に失敗しました。");
      setWorkflows((prev) =>
        prev.map((w) => (w.id === workflow.id ? (data.workflow as StudioCustomWorkflow) : w)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました。");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (workflow: StudioCustomWorkflow) => {
    if (!window.confirm(`「${workflow.title}」を削除しますか？`)) return;
    setBusyId(workflow.id);
    try {
      const res = await fetch(`/api/admin/custom-workflows/${workflow.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "削除に失敗しました。");
      setWorkflows((prev) => prev.filter((w) => w.id !== workflow.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
    } finally {
      setBusyId(null);
    }
  };

  const handleSaved = (workflow: StudioCustomWorkflow) => {
    setWorkflows((prev) => {
      const exists = prev.some((w) => w.id === workflow.id);
      const next = exists ? prev.map((w) => (w.id === workflow.id ? workflow : w)) : [...prev, workflow];
      return next.sort((a, b) => b.priority - a.priority);
    });
    setModalState({ open: false, workflow: null });
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-muted">
          ローカルComfyUIからエクスポートしたAPI JSONを登録し、Studioの「特化ワークフロー」タブに動的なUIとして公開します。
        </p>
        <button
          type="button"
          onClick={() => setModalState({ open: true, workflow: null })}
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
      ) : workflows.length === 0 ? (
        <div className="rounded-2xl border-gradient bg-surface/40 px-6 py-16 text-center text-sm text-muted">
          特化ワークフローがまだ登録されていません。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-surface/60 text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">タイトル</th>
                <th className="px-4 py-3 font-medium">slug</th>
                <th className="px-4 py-3 font-medium">カテゴリ</th>
                <th className="px-4 py-3 font-medium">パラメータ数</th>
                <th className="px-4 py-3 font-medium">消費クレジット</th>
                <th className="px-4 py-3 font-medium">優先度</th>
                <th className="px-4 py-3 font-medium">状態</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((workflow) => (
                <tr
                  key={workflow.id}
                  className="border-b border-border/60 last:border-0 hover:bg-surface-hover/40"
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Workflow size={13} className="shrink-0 text-neon-violet" />
                      {workflow.title}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{workflow.slug}</td>
                  <td className="px-4 py-3 text-muted">{workflow.category}</td>
                  <td className="px-4 py-3 text-muted">{workflow.input_schema.length}</td>
                  <td className="px-4 py-3 text-muted">{workflow.credits_cost}</td>
                  <td className="px-4 py-3 text-muted">{workflow.priority}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(workflow)}
                      disabled={busyId === workflow.id}
                      className={`flex items-center gap-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        workflow.is_active ? "text-neon-pink" : "text-muted"
                      }`}
                    >
                      {workflow.is_active ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      {workflow.is_active ? "有効" : "無効"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => handleCopyJson(workflow)}
                        aria-label="JSONをコピー"
                        title="📋 workflow_json をコピー"
                        className="text-muted transition-colors hover:text-neon-violet"
                      >
                        <Clipboard size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownloadJson(workflow)}
                        aria-label="JSONをダウンロード"
                        title="📥 workflow_json をダウンロード"
                        className="text-muted transition-colors hover:text-neon-violet"
                      >
                        <Download size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setModalState({ open: true, workflow })}
                        aria-label="編集"
                        className="text-muted transition-colors hover:text-neon-violet"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(workflow)}
                        disabled={busyId === workflow.id}
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
        <CustomWorkflowModal
          workflow={modalState.workflow}
          onClose={() => setModalState({ open: false, workflow: null })}
          onSaved={handleSaved}
        />
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
