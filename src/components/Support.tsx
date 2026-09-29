"use client";

import { useEffect, useState } from "react";
import { Heart, Loader2, MessageSquare } from "lucide-react";
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
  // 範囲の案内は打ち終わってから（欄を離れたとき）だけ出す。打っている途中の「1」「10」で出ると 100 が弾かれて見える（2026-09-29）。
  const [customTouched, setCustomTouched] = useState(false);
  const [useCustom, setUseCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState(false);
  // 支援者からのひとこと（2026-09-29）: 決済から戻ったときだけ書ける。checkout_id で寄付を確かめて受け付ける。
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteName, setNoteName] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteSent, setNoteSent] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // Polar から ?donation=thanks で戻ってきたときだけお礼を出す。checkout_id は再読み込みでも書けるよう
  // sessionStorage に残す（URL からは消す）。
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("donation") === "thanks") {
        const id = url.searchParams.get("checkout_id");
        // 同期 setState を避ける（react-hooks/set-state-in-effect）。
        void Promise.resolve().then(() => {
          setThanks(true);
          if (id && !id.includes("{")) {
            setCheckoutId(id);
            try {
              window.sessionStorage.setItem("ull_support_checkout", id);
            } catch {
              // ignore
            }
          }
        });
        url.searchParams.delete("donation");
        url.searchParams.delete("checkout_id");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash || "#support"}`);
      } else {
        const saved = window.sessionStorage.getItem("ull_support_checkout");
        if (saved) void Promise.resolve().then(() => setCheckoutId(saved));
      }
    } catch {
      // ignore
    }
  }, []);

  const sendNote = async () => {
    if (!checkoutId || !note.trim() || noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    try {
      const res = await fetch("/api/support/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkoutId, message: note, name: noteName }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "送信に失敗しました。");
      setNoteSent(true);
      setNote("");
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : "送信に失敗しました。");
    } finally {
      setNoteBusy(false);
    }
  };

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
          {checkoutId && (
            <div className="mx-auto mt-4 max-w-md space-y-2 rounded-xl border border-neon-violet/40 bg-neon-violet/5 px-4 py-3 text-left">
              {noteSent ? (
                <p className="text-sm text-neon-violet">ひとこと、確かに受け取りました。ありがとうございます。</p>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground">ひとこと添えませんか？（任意）</p>
                  <p className="text-[11px] leading-relaxed text-muted">
                    「こうなったらいいな」「この設定が欲しい」など、何でもどうぞ。次に作るものを決めるとき、ちゃんと読んでいます。
                  </p>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={4}
                    maxLength={2000}
                    placeholder="例: LoRA の学習設定をもう少し細かく選べるとうれしいです"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60"
                  />
                  <input
                    type="text"
                    value={noteName}
                    onChange={(e) => setNoteName(e.target.value)}
                    maxLength={50}
                    placeholder="お名前（任意・ニックネーム可）"
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted/60"
                  />
                  {noteError && <p className="text-xs text-red-300">{noteError}</p>}
                  <button
                    type="button"
                    onClick={() => void sendNote()}
                    disabled={noteBusy || !note.trim()}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {noteBusy ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
                    ひとことを送る
                  </button>
                </>
              )}
            </div>
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
                onFocus={() => {
                  setUseCustom(true);
                  setCustomTouched(false);
                }}
                onBlur={() => setCustomTouched(true)}
                onChange={(e) => {
                  setUseCustom(true);
                  // 全角数字（日本語入力のまま打った「１００」）も半角にして受け付ける。
                  const half = e.target.value.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
                  setCustom(half.replace(/[^0-9]/g, "").slice(0, 7));
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
          {useCustom && custom && customTouched && !amountValid && (
            <p className="mt-2 text-xs text-red-300">
              {amount > MAX_JPY
                ? `一度にご支援いただけるのは ¥${MAX_JPY.toLocaleString()} までです。`
                : `¥${MIN_JPY.toLocaleString()} 以上で入力してください。`}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-300">{error}</p>}

          <p className="mt-4 text-[11px] leading-relaxed text-muted">
            決済は Polar.sh（クレジットカード・Apple Pay・Google Pay）。ログインしていなくても支援できます。
            <br />
            寄付は返金・クレジット付与の対象外です。
          </p>

          {/* 支援とひとことをセットに（2026-09-29 ホスト案）。会員特典の機能リクエストとは別枠のゆるい窓口。 */}
          <div className="mt-5 flex items-start gap-2 rounded-xl border border-neon-violet/30 bg-neon-violet/5 px-5 py-4 text-left text-sm leading-relaxed text-foreground/90">
            <MessageSquare size={16} className="mt-0.5 shrink-0 text-neon-violet" />
            <span>
              <EditableText
                as="span"
                siteKey="support_note_copy"
                fallback="「要望を送るのは、ちょっと気が引ける」という方へ。ご支援に “こうなったらいいな” をひとこと添えてください。次に作るものを決めるとき、ちゃんと読んでいます。"
              />
              <span className="mt-1 block text-[11px] text-muted">支援の決済が終わると、ひとことを書く欄が出ます。</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
