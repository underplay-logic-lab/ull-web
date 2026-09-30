"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Download, KeyRound, Loader2 } from "lucide-react";
import { licenseProductLabel } from "@/lib/license/products";

// ネットにつながらない PC の代わりに、スマホで納品ツールを認証するページ（2026-09-30）。
// ツールの認証画面の QR コードが /license/offline?p=<ツール ID>&h=<HWID> を指す。ここでキーを入れると、
// その PC 専用のライセンスファイルがスマホにダウンロードされる。相手はそれを PC に移して「ライセンスファイルを読み込む」。
// 台数の上限はオンライン認証と同じく効く。仕組みは src/lib/license/license.server.ts。

type Params = { product: string; hwid: string };

function readParams(): Params | null {
  const sp = new URLSearchParams(window.location.search);
  const product = sp.get("p") ?? "";
  const hwid = (sp.get("h") ?? "").replace(/[\s-]/g, "").toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(product) && /^[0-9a-f]{64}$/.test(hwid) ? { product, hwid } : null;
}

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function LicenseOfflinePage() {
  const [params, setParams] = useState<Params | null | undefined>(undefined);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL is only readable after mount
    setParams(readParams());
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!params || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, hwid: params.hwid, product: params.product, offline: true }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.token) throw new Error(json?.error ?? "認証に失敗しました。");
      const file = { name: `${params.product}.license`, token: `${json.token}\n` };
      setIssued(file);
      saveFile(file.name, file.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "認証に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4 py-24">
      <div className="relative w-full max-w-sm rounded-2xl border-gradient bg-surface p-6 sm:p-8">
        <div className="mb-2 flex items-center gap-2 text-neon-pink">
          <KeyRound size={16} />
        </div>
        {params === undefined ? (
          <p className="flex items-center justify-center gap-2 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" /> 読み込み中...
          </p>
        ) : params === null ? (
          <>
            <h1 className="text-lg font-bold text-foreground">QR コードを読み取れませんでした</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              ツールの認証画面に表示されている QR コードを、もう一度スマホのカメラで読み取ってください。
            </p>
          </>
        ) : issued ? (
          <>
            <h1 className="text-lg font-bold text-foreground">ライセンスファイルを保存しました</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              「{issued.name}」がこのスマホにダウンロードされました。次の手順で PC に移してください。
            </p>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-foreground/90">
              <li>USB ケーブル・USB メモリ・クラウド（Google ドライブ等）などで、このファイルを PC に移す。</li>
              <li>ツールの認証画面で「ライセンスファイルを読み込む」を押し、移したファイルを選ぶ。</li>
            </ol>
            <button
              type="button"
              onClick={() => saveFile(issued.name, issued.token)}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm text-foreground hover:bg-surface-hover"
            >
              <Download size={16} /> もう一度ダウンロードする
            </button>
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              このファイルは、QR コードを表示した PC でだけ使えます。
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-bold text-foreground">{licenseProductLabel(params.product)} の認証</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              ネットにつながらない PC の代わりに、このスマホで認証します。お渡ししたライセンスキーを入力してください。
            </p>
            <form onSubmit={submit} className="mt-5 space-y-3">
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="ULL-XXXXX-XXXXX-XXXXX-XXXXX"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-background px-4 py-2.5 font-mono text-sm text-foreground outline-none focus:border-neon-violet/50"
              />
              {error && (
                <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>
              )}
              <button
                type="submit"
                disabled={busy || !key.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
              >
                {busy && <Loader2 size={16} className="animate-spin" />}
                認証してライセンスファイルを受け取る
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
