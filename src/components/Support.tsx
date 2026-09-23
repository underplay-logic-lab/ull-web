"use client";

import { useEffect, useState } from "react";
import { Heart, Loader2 } from "lucide-react";
import { EditableText } from "@/components/EditableText";
import { supabase } from "@/lib/supabaseClient";

// 「支援（寄付）」セクション（2026-09-24、ホスト要望）。
// いただいた支援はサーバー・GPU の維持費と新機能の開発に使う。見返りのクレジット
// 付与は無い（純粋な寄付。/api/checkout/donation → Polar の Pay-what-you-want 商品）。
// 金額はプリセット 3 つ＋自由入力（固定だけだと少額派・高額派を取りこぼし、
// 入力だけだと迷って離脱するため）。ログイン無しでも支援できる。

const PRESETS = [500, 1000, 3000] as const;
const MIN_JPY = 100;
const MAX_JPY = 1_000_000;

export function Support() {
  const [selected, setSelected] = useState<number>(1000);
  const [custom, setCustom] = useState<string>("");
  const [useCustom, setUseCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);

  // Polar から ?donation=thanks で戻ってきたときだけお礼を出す。
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("donation") === "thanks") {
        // 同期 setState を避ける（react-hooks/set-state-in-effect）。
        void Promise.resolve().then(() => setThanks(true));
        url.searchParams.delete("donation");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash || "#support"}`);
      }
    } catch {
      // ignore
    }
  }, []);

  const amount = useCustom ? Number.parseInt(custom.replace(/[^0-9]/g, ""), 10) : selected;
  const amountValid = Number.isFinite(amount) && amount >= MIN_JPY && amount <= MAX_JPY;

  const submit = async () => {
    if (!amountValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/api/checkout/donation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.checkoutUrl) {
        throw new Error(data?.error || "決済ページを開けませんでした。");
      }
      window.location.assign(data.checkoutUrl as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "決済ページを開けませんでした。");
      setBusy(false);
    }
  };

  return (
    <section id="support" data-source-file="src/components/Support.tsx" className="relative py-20 sm:py-24">
      <div className="mx-auto max-w-3xl px-6">
        <div className="rounded-2xl border border-neon-pink/30 bg-surface/50 p-6 text-center sm:p-8">
          <EditableText
            as="p"
            siteKey="support_eyebrow"
            fallback="Support"
            className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink"
          />
          <EditableText
            as="h2"
            siteKey="support_title"
            fallback="ULL Studio を支える"
            className="text-2xl font-bold tracking-tight sm:text-3xl"
          />
          <EditableText
            as="p"
            siteKey="support_subtitle"
            fallback="いただいた支援は、サーバー・GPU の維持費と新機能の開発に使わせていただきます。金額は自由です（クレジットの付与はありません）。"
            className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted"
          />

          {thanks && (
            <p className="mx-auto mt-5 max-w-md rounded-xl border border-neon-pink/40 bg-neon-pink/10 px-4 py-3 text-sm text-neon-pink">
              ご支援ありがとうございます。維持費と機能追加に大切に使わせていただきます。
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setSelected(v);
                  setUseCustom(false);
                }}
                className={`rounded-full border px-5 py-2 text-sm font-mono font-medium transition-colors ${
                  !useCustom && selected === v
                    ? "border-neon-pink/50 bg-neon-pink/15 text-neon-pink"
                    : "border-border bg-surface/40 text-muted hover:border-neon-violet/40 hover:text-foreground"
                }`}
              >
                ¥{v.toLocaleString()}
              </button>
            ))}
            <label
              className={`flex items-center gap-1 rounded-full border px-4 py-1.5 text-sm font-mono transition-colors ${
                useCustom
                  ? "border-neon-pink/50 bg-neon-pink/15 text-neon-pink"
                  : "border-border bg-surface/40 text-muted hover:border-neon-violet/40"
              }`}
            >
              <span>¥</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="他の金額"
                value={custom}
                onFocus={() => setUseCustom(true)}
                onChange={(e) => {
                  setUseCustom(true);
                  setCustom(e.target.value.replace(/[^0-9]/g, "").slice(0, 7));
                }}
                className="w-24 bg-transparent text-foreground outline-none placeholder:text-muted/70"
                aria-label="支援金額（円）"
              />
            </label>
          </div>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!amountValid || busy}
            className="mt-6 inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet px-7 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Heart size={16} />}
            {amountValid ? `¥${amount.toLocaleString()} を支援する` : "金額を選んでください"}
          </button>
          {useCustom && custom && !amountValid && (
            <p className="mt-2 text-xs text-red-300">
              ¥{MIN_JPY.toLocaleString()} 〜 ¥{MAX_JPY.toLocaleString()} の範囲で入力してください。
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-300">{error}</p>}

          <p className="mt-4 text-[11px] leading-relaxed text-muted">
            決済は Polar.sh（クレジットカード・Apple Pay・Google Pay）。ログインしていなくても支援できます。
            <br />
            寄付は返金・クレジット付与の対象外です。
          </p>
        </div>
      </div>
    </section>
  );
}
