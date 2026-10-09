"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { FEATURES, FEATURE_KEYS, type FeatureKey } from "@/lib/features";

// admin「機能の許可」（2026-10-09）— 一般公開しない機能を、メールアドレスで指定した会員にだけ開ける。
// 機能の一覧は src/lib/features.ts。admin 自身は許可が無くても全部使える。

type Grant = {
  user_id: string;
  email: string | null;
  feature: string;
  note: string | null;
  granted_by: string | null;
  expires_at: string | null;
  created_at: string;
};

function featureLabel(f: string): string {
  return f in FEATURES ? FEATURES[f as FeatureKey].label : `${f}（未定義）`;
}

export function FeatureGrantsTab() {
  const [rows, setRows] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [feature, setFeature] = useState<FeatureKey>(FEATURE_KEYS[0]);
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0); // 期限切れの判定の基準（描画中に Date.now() を呼ばない）

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/feature-grants");
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "取得に失敗しました。");
      setRows((json as { grants: Grant[] }).grants);
      setLoadedAt(Date.now());
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

  const grant = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/feature-grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, feature, note, expires_at: expires ? `${expires}T23:59:59+09:00` : null }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "付与に失敗しました。");
      setEmail("");
      setNote("");
      setExpires("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "付与に失敗しました。");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (r: Grant) => {
    if (!window.confirm(`${r.email ?? r.user_id} の「${featureLabel(r.feature)}」を取り消しますか？`)) return;
    setError(null);
    try {
      const res = await fetch("/api/admin/feature-grants", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: r.user_id, feature: r.feature }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "取り消しに失敗しました。");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "取り消しに失敗しました。");
    }
  };

  return (
    <section>
      <div className="mb-6 rounded-xl border border-border bg-surface/40 p-4">
        <p className="mb-3 text-sm text-foreground">機能を許可する</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-muted">
            会員のメールアドレス
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted">
            機能
            <select
              value={feature}
              onChange={(e) => setFeature(e.target.value as FeatureKey)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {FEATURE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {FEATURES[k].label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px]">{FEATURES[feature].description}</span>
          </label>
          <label className="text-xs text-muted">
            メモ（任意・誰の何の件か）
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs text-muted">
            期限（任意・この日の終わりまで。空欄は無期限）
            <input
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={saving || !email.trim()}
          onClick={() => void grant()}
          className="mt-3 rounded-full border border-neon-pink/60 px-4 py-1.5 text-xs text-neon-pink transition-colors hover:bg-neon-pink/10 disabled:opacity-40"
        >
          {saving ? "付与中…" : "許可する"}
        </button>
        <p className="mt-2 text-[11px] text-muted">同じ人・同じ機能にもう一度付けると、メモと期限が上書きされます。</p>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-foreground">
          許可している会員 <span className="font-mono font-semibold text-neon-pink">{rows.length}</span> 件
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground"
        >
          <RefreshCw size={12} />
          再読み込み
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {loading && rows.length === 0 && <p className="text-xs text-muted">読み込み中…</p>}
      {!loading && rows.length === 0 && <p className="text-xs text-muted">まだ誰にも許可していません。</p>}

      <div className="space-y-2">
        {rows.map((r) => {
          const expired = !!r.expires_at && new Date(r.expires_at).getTime() <= loadedAt;
          return (
            <article
              key={`${r.user_id}:${r.feature}`}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border p-3 text-xs ${
                expired ? "bg-surface/20 opacity-60" : "bg-surface/40"
              }`}
            >
              <span className="text-foreground">{r.email ?? r.user_id}</span>
              <span className="rounded-full bg-neon-pink/15 px-2 py-0.5 text-neon-pink">{featureLabel(r.feature)}</span>
              <span className="text-muted">
                {r.expires_at
                  ? `${expired ? "期限切れ" : "期限"} ${new Date(r.expires_at).toLocaleDateString("ja-JP")}`
                  : "無期限"}
              </span>
              {r.note && <span className="text-muted">・{r.note}</span>}
              <span className="text-muted">
                ・{new Date(r.created_at).toLocaleDateString("ja-JP")} {r.granted_by ?? ""}
              </span>
              <button
                type="button"
                onClick={() => void revoke(r)}
                className="ml-auto rounded-full border border-border px-3 py-1 text-[11px] text-muted transition-colors hover:text-red-400"
              >
                取り消す
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
