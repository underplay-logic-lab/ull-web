"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { SITE_CONTENT_SECTION_LABEL } from "@/lib/siteContents";
import type { SiteContentRow } from "./types";

export function SiteContentsTab() {
  const [contents, setContents] = useState<SiteContentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const loadContents = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/site-contents");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "取得に失敗しました。");
      const rows = data.contents as SiteContentRow[];
      setContents(rows);
      setDrafts(Object.fromEntries(rows.map((r) => [r.key, r.value])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadContents();
  }, []);

  const handleSave = async (key: string) => {
    const draft = drafts[key];
    if (draft === undefined) return;

    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch(`/api/admin/site-contents/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "保存に失敗しました。");

      const updated = data.content as SiteContentRow;
      setContents((prev) => prev.map((c) => (c.key === key ? updated : c)));
      setDrafts((prev) => ({ ...prev, [key]: updated.value }));
      setSavedKey(key);
      setTimeout(() => setSavedKey((cur) => (cur === key ? null : cur)), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSavingKey(null);
    }
  };

  const sections = Array.from(new Set(contents.map((c) => c.section)));

  return (
    <div>
      <p className="mb-5 text-sm text-muted">
        トップページのHero・Studio・料金プラン・フッターの文言をここから編集できます。保存後、トップページをリロードすると反映されます。
      </p>

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
      ) : contents.length === 0 ? (
        <div className="rounded-2xl border-gradient bg-surface/40 px-6 py-16 text-center text-sm text-muted">
          サイトコンテンツがまだ登録されていません。
        </div>
      ) : (
        <div className="space-y-8">
          {sections.map((section) => (
            <div key={section}>
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neon-violet">
                {SITE_CONTENT_SECTION_LABEL[section] ?? section}
              </h4>
              <div className="space-y-3">
                {contents
                  .filter((c) => c.section === section)
                  .map((row) => (
                    <div key={row.key} className="rounded-xl border border-border bg-background/60 p-3">
                      <div className="mb-1.5 flex items-center justify-between">
                        <label className="text-xs font-medium text-foreground">{row.label}</label>
                        <span className="font-mono text-[10px] text-muted">{row.key}</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <textarea
                          rows={2}
                          value={drafts[row.key] ?? row.value}
                          onChange={(e) =>
                            setDrafts((prev) => ({ ...prev, [row.key]: e.target.value }))
                          }
                          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                        />
                        <button
                          type="button"
                          onClick={() => handleSave(row.key)}
                          disabled={savingKey === row.key || drafts[row.key] === row.value}
                          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {savingKey === row.key ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : savedKey === row.key ? (
                            <Check size={13} className="text-neon-pink" />
                          ) : (
                            <Save size={13} />
                          )}
                          {savedKey === row.key ? "保存済み" : "💾 変更を保存"}
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
