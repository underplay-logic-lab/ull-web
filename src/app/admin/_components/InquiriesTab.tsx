"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

// admin「問い合わせ」— /api/contact の受信箱（2026-09-28）。会員特典「上位プランから優先して検討」のため、
// 未対応をプランの高い順に並べる（並べ替えは /api/admin/inquiries）。対応済みにすると下へ回る。

type Inquiry = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  service: string | null;
  message: string;
  member_tier: string | null;
  handled_at: string | null;
  email_sent: boolean;
  created_at: string;
};

const TIER_LABEL: Record<string, string> = {
  studio: "スタジオ",
  master: "マスター",
  pro: "プロ",
  standard: "スタンダード",
  entry: "エントリー",
};

export function InquiriesTab() {
  const [rows, setRows] = useState<Inquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHandled, setShowHandled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/inquiries");
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "取得に失敗しました。");
      setRows((json as { inquiries: Inquiry[] }).inquiries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  const setHandled = async (id: string, handled: boolean) => {
    try {
      const res = await fetch("/api/admin/inquiries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, handled }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "更新に失敗しました。");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新に失敗しました。");
    }
  };

  const openCount = rows.filter((r) => !r.handled_at).length;
  const visible = showHandled ? rows : rows.filter((r) => !r.handled_at);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground">
          未対応 <span className="font-mono font-semibold text-neon-pink">{openCount}</span> 件（プランの高い順 → 新しい順）
        </p>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} />
            対応済みも表示
          </label>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
          >
            <RefreshCw size={12} />
            再読み込み
          </button>
        </div>
      </div>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {loading && rows.length === 0 && <p className="text-xs text-muted">読み込み中…</p>}
      {!loading && visible.length === 0 && <p className="text-xs text-muted">表示する問い合わせはありません。</p>}

      <div className="space-y-3">
        {visible.map((r) => (
          <article
            key={r.id}
            className={`rounded-xl border p-4 ${r.handled_at ? "border-border bg-surface/20 opacity-60" : "border-border bg-surface/40"}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`rounded-full px-2 py-0.5 font-mono ${
                  r.member_tier ? "bg-neon-pink/15 text-neon-pink" : "bg-surface text-muted"
                }`}
              >
                {r.member_tier ? TIER_LABEL[r.member_tier] ?? r.member_tier : "非会員"}
              </span>
              <span className="text-foreground/90">{r.service ?? "（相談内容なし）"}</span>
              <span className="text-muted">{new Date(r.created_at).toLocaleString("ja-JP")}</span>
              {!r.email_sent && <span className="text-amber-400">通知メール未送信</span>}
              <button
                type="button"
                onClick={() => void setHandled(r.id, !r.handled_at)}
                className="ml-auto rounded-full border border-border px-3 py-1 text-[11px] text-muted transition-colors hover:text-foreground"
              >
                {r.handled_at ? "未対応に戻す" : "対応済みにする"}
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">
              {r.name}（<a href={`mailto:${r.email}`} className="hover:text-neon-pink">{r.email}</a>）
              {r.company ? `・${r.company}` : ""}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{r.message}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
