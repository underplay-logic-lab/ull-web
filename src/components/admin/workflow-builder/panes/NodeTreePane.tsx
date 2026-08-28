"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Cpu, Plus, Search } from "lucide-react";
import type { WorkflowNodeInfo } from "@/lib/workflowGraph";
import { isLinkValue } from "@/lib/workflowGraph";

// Left pane (25%): a "system inputs" block (GPU selector), then every node
// parsed from workflow_json, searchable, with a "+ UI に公開" button next to
// each literal (non-wired) input.
export function NodeTreePane({
  nodes,
  exposedKeys,
  onExpose,
  hasGpuTierField,
  onAddGpuTierField,
}: {
  nodes: WorkflowNodeInfo[];
  // `${nodeId}:${fieldName}` for every input already mapped by an input_schema entry.
  exposedKeys: Set<string>;
  onExpose: (node: WorkflowNodeInfo, fieldName: string) => void;
  hasGpuTierField: boolean;
  onAddGpuTierField: () => void;
}) {
  const [query, setQuery] = useState("");
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (n) =>
        n.nodeId.toLowerCase().includes(q) ||
        n.classType.toLowerCase().includes(q) ||
        n.title.toLowerCase().includes(q),
    );
  }, [nodes, query]);

  return (
    <div className="flex h-full flex-col border-r border-border bg-surface/30">
      <div className="border-b border-border p-3">
        <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neon-pink">
          <Cpu size={12} />
          システム入力
        </h2>
        <button
          type="button"
          disabled={hasGpuTierField}
          onClick={onAddGpuTierField}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-neon-pink/40 bg-neon-pink/10 px-2 py-1.5 text-[11px] font-medium text-neon-pink transition-colors hover:bg-neon-pink/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted"
        >
          {hasGpuTierField ? (
            "⚡ GPU選択セレクター（配置済み）"
          ) : (
            <>
              <Plus size={11} />⚡ GPU選択セレクターを配置
            </>
          )}
        </button>
      </div>

      <div className="border-b border-border p-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neon-violet">
          ノードツリー（{nodes.length}）
        </h2>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
          <Search size={13} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="class_type / Node ID で検索"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted">
            {nodes.length === 0
              ? "workflow_json が空、またはComfyUI API形式ではありません。"
              : "一致するノードがありません。"}
          </p>
        ) : (
          filtered.map((node) => {
            const isOpen = openNodeId === node.nodeId;
            const inputEntries = Object.entries(node.inputs);
            return (
              <div key={node.nodeId} className="mb-1.5 rounded-lg border border-border bg-background">
                <button
                  type="button"
                  onClick={() => setOpenNodeId(isOpen ? null : node.nodeId)}
                  className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
                >
                  <span className="min-w-0 truncate text-[11px] text-foreground">
                    <span className="font-mono text-muted">[{node.nodeId}]</span> {node.title}
                    <span className="text-muted"> ({node.classType})</span>
                  </span>
                  <ChevronDown
                    size={13}
                    className={`shrink-0 text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen && (
                  <div className="border-t border-border/70 p-1.5">
                    {inputEntries.length === 0 && (
                      <p className="px-1.5 py-1 text-[10px] text-muted">inputs なし</p>
                    )}
                    {inputEntries.map(([fieldName, value]) => {
                      const wired = isLinkValue(value);
                      const key = `${node.nodeId}:${fieldName}`;
                      const exposed = exposedKeys.has(key);
                      return (
                        <div
                          key={fieldName}
                          className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-surface/50"
                        >
                          <span className="min-w-0 truncate font-mono text-[10px] text-foreground/80">
                            {fieldName}
                            <span className="text-muted">
                              {" = "}
                              {wired ? "（配線）" : JSON.stringify(value)}
                            </span>
                          </span>
                          <button
                            type="button"
                            disabled={wired || exposed}
                            onClick={() => onExpose(node, fieldName)}
                            title={
                              wired
                                ? "配線された入力は公開できません"
                                : exposed
                                  ? "すでにUIに公開済みです"
                                  : "この入力をUIに公開"
                            }
                            className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[9px] font-medium text-muted transition-colors hover:border-neon-pink/40 hover:text-neon-pink disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Plus size={9} />
                            {exposed ? "公開済み" : "UIに公開"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
