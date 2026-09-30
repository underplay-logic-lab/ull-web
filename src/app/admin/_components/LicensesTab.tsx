"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, RefreshCw } from "lucide-react";
import { LICENSE_PRODUCTS, licenseProductLabel } from "@/lib/license/products";

// admin「ライセンス」（2026-09-30）— 納品ツールのライセンス台帳。仕組みは src/lib/license/license.server.ts。
// 発行 → キーを相手に渡す（ツールの初回起動で入力）。ネットに出られない相手は HWID を受け取って「手動発行」でファイルを渡す。

type Activation = {
  id: string;
  hwid: string;
  method: "online" | "manual";
  activated_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

type License = {
  id: string;
  product: string;
  licensee: string;
  contact: string | null;
  note: string | null;
  key_hint: string;
  max_devices: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  license_activations: Activation[];
};

const fmt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => {});
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 期限（ISO）→ 日本時間の日付（yyyy-mm-dd）。発行フォームと同じく「その日の終わり」まで有効という扱い。
function jstDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

// 発行後の台数・期限の変更（2026-09-30 ホスト要望）。台数を減らしても認証済みの PC は外れない（新しい認証だけ止まる）。
function LimitsEditor({ lic, onSave }: { lic: License; onSave: (maxDevices: number, expiresAt: string) => Promise<void> }) {
  const [devices, setDevices] = useState(lic.max_devices);
  const [date, setDate] = useState(jstDate(lic.expires_at));
  const [saving, setSaving] = useState(false);
  const dirty = devices !== lic.max_devices || date !== jstDate(lic.expires_at);
  const activeCount = lic.license_activations.filter((a) => !a.revoked_at).length;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
      <span>台数</span>
      <input
        type="number"
        min={1}
        max={50}
        value={devices}
        onChange={(e) => setDevices(Number(e.target.value) || 1)}
        className="w-16 rounded-md border border-border bg-background px-2 py-1 text-foreground"
      />
      <span>期限</span>
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
      />
      {date && (
        <button type="button" onClick={() => setDate("")} className="hover:text-foreground">
          無期限にする
        </button>
      )}
      {dirty && (
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await onSave(devices, date ? `${date}T23:59:59+09:00` : "");
            setSaving(false);
          }}
          className="rounded-full border border-neon-pink/50 px-3 py-0.5 text-neon-pink hover:bg-neon-pink/10 disabled:opacity-50"
        >
          変更を保存
        </button>
      )}
      {devices < activeCount && (
        <span className="text-amber-400">認証済みの PC（{activeCount} 台）は外れません。減らすなら下の「解除」も必要です。</span>
      )}
    </div>
  );
}

export function LicensesTab() {
  const [rows, setRows] = useState<License[]>([]);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 期限切れの判定に使う「今」（描画中に Date.now() を呼ばない）。読み込みのたびに更新。
  const [loadedAt, setLoadedAt] = useState(0);

  const [product, setProduct] = useState<string>(LICENSE_PRODUCTS[0].id);
  const [licensee, setLicensee] = useState("");
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");
  const [maxDevices, setMaxDevices] = useState(1);
  const [expiresAt, setExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ licensee: string; key: string } | null>(null);
  const [manualHwid, setManualHwid] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/licenses");
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "取得に失敗しました。");
      setRows(json.licenses as License[]);
      setPublicKey(json.publicKey ?? null);
      setKeyError(json.keyError ?? null);
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

  const call = async (method: "POST" | "PATCH", body: unknown) => {
    const res = await fetch("/api/admin/licenses", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error ?? "失敗しました。");
    return json;
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const json = await call("POST", {
        action: "create",
        product,
        licensee,
        contact,
        note,
        maxDevices,
        // 期限は「その日の終わり（日本時間）」まで。
        expiresAt: expiresAt ? `${expiresAt}T23:59:59+09:00` : "",
      });
      setIssued({ licensee, key: json.key as string });
      setLicensee("");
      setContact("");
      setNote("");
      setExpiresAt("");
      setMaxDevices(1);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "発行に失敗しました。");
    } finally {
      setCreating(false);
    }
  };

  const patch = async (body: unknown) => {
    setError(null);
    try {
      await call("PATCH", body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新に失敗しました。");
    }
  };

  const manualIssue = async (lic: License) => {
    setError(null);
    try {
      const json = await call("POST", { action: "manual", licenseId: lic.id, hwid: manualHwid[lic.id] ?? "" });
      downloadText(`${json.product}.license`, `${json.token}\n`);
      setManualHwid((m) => ({ ...m, [lic.id]: "" }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "発行に失敗しました。");
    }
  };

  const input =
    "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60";

  return (
    <section className="space-y-6">
      <div className="rounded-xl border border-border bg-surface/40 p-4 text-xs leading-relaxed text-muted">
        <p className="text-foreground">
          納品ツール（手元の PC で動かすもの）のライセンス。発行したキーを相手に渡し、ツールの初回起動で入力してもらいます。
          ネットにつながらない相手は、ツールに出る HWID を送ってもらい「手動発行」でライセンスファイルを渡します。
        </p>
        <p className="mt-2">
          停止・端末の解除は、ツールがオンラインで再確認したとき（30 日ごと）に効きます。手動発行のファイルは再確認しないので、期限で縛ってください。
        </p>
        <details className="mt-3 rounded-lg border border-border bg-background/60 p-3">
          <summary className="cursor-pointer text-foreground">手順（発行のしかた・新しいツールの追加）</summary>
          <div className="mt-2 space-y-3">
            <div>
              <p className="font-medium text-foreground">■ 相手に渡す（通常）</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                <li>下の「新しく発行する」で、ツール・名義（管理用の呼び名）・台数・期限を入れて「発行する」。</li>
                <li>表示されたキー（ULL-XXXXX-…）を控える。<span className="text-amber-400">キーはこの時だけ表示され、あとから見られません。</span></li>
                <li>ツールの ZIP（build.bat で作る dist\〇〇-v版.zip）とキーを相手に送る。exe は全員同じもので良い。</li>
                <li>相手が初回起動でキーを入力 →「認証する」。認証するとこの一覧のそのライセンスに PC が 1 台追加される。</li>
              </ol>
            </div>
            <div>
              <p className="font-medium text-foreground">■ 相手の PC がネットにつながらないとき</p>
              <p className="mt-1">
                基本は相手が自分で済ませる: 認証画面の「スマホで認証する」→ QR をスマホで読む → キーを入力 → ライセンスファイルがスマホに保存 →
                PC に移して「ライセンスファイルを読み込む」。こちらの作業は不要（一覧には「手動」として PC が増える）。
              </p>
              <p className="mt-2">それでも困って連絡が来たとき（認証画面の「困ったときは」から HWID が届く）:</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                <li>その人のライセンスの「手動発行」欄に HWID を貼り付けて「ライセンスファイルを作る」→ 〇〇.license がダウンロードされる。</li>
                <li>そのファイルを相手に送り、認証画面の「ライセンスファイルを読み込む」で選んでもらう。</li>
              </ol>
            </div>
            <div>
              <p className="font-medium text-foreground">■ 発行したあと</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>台数・期限はライセンスごとに変えられる（延長は、相手のツールがネットにつながったときに反映）。</li>
                <li>PC を入れ替えたいときは「この PC を解除」で枠を空ける。止めたいときは「停止する」。</li>
                <li>停止・解除は、相手のツールがネットにつながって確認したとき（30 日ごと）に効く。ずっとオフラインの PC は止められない。</li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-foreground">■ どのツールのキーか（ツール ID でつながる）</p>
              <p className="mt-1">
                「ツール」の選択肢には ID が付いている（例: Underplay FramePicker = framepicker）。キーはその ID のツール専用として記録され、
                ツールは認証のときに自分の ID を送る。ID が一致したときだけ認証される（別のツールのキーは「キーが正しくありません」）。
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground">■ 新しいツールを追加するとき（開発側）</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                <li>ULL Studio の src/lib/license/products.ts にツールの ID と名前を足して push（この画面の「ツール」に出る）。</li>
                <li>ツールのフォルダに tools/ull_license/ull_license.py をコピーし、main.py で ensure_license(product=同じ ID, public_key_b64=下の公開鍵, …) を呼ぶ。QR 表示のため requirements に qrcode を足す。</li>
                <li>FramePicker の build.bat をコピーして名前・版を直し、ビルド。詳しくは D:\tool\Underplay-FramePicker\exe化（まとめ）.txt。</li>
              </ol>
            </div>
          </div>
        </details>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span>ツールに埋め込む公開鍵（全ツール共通）:</span>
          {publicKey ? (
            <>
              <code className="rounded bg-background px-2 py-0.5 font-mono text-[11px] text-foreground">{publicKey}</code>
              <button type="button" onClick={() => copy(publicKey)} className="text-muted hover:text-foreground" aria-label="公開鍵をコピー">
                <Copy size={12} />
              </button>
            </>
          ) : (
            <span className="text-amber-400">{keyError ?? "読み込み中…"}</span>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-neon-pink/30 bg-surface/40 p-4">
        <p className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
          <KeyRound size={14} /> 新しく発行する
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-muted">
            ツール
            <select value={product} onChange={(e) => setProduct(e.target.value)} className={`${input} mt-1`}>
              {LICENSE_PRODUCTS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}（ID: {p.id}）
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            名義（管理用の呼び名・本名でなくてよい。ツール画面には出ませんが、ライセンスファイルには含まれます）
            <input value={licensee} onChange={(e) => setLicensee(e.target.value)} className={`${input} mt-1`} placeholder="例: 平丸さんのお客様 A" />
          </label>
          <label className="text-xs text-muted">
            連絡先（任意・メールや LINE 名）
            <input value={contact} onChange={(e) => setContact(e.target.value)} className={`${input} mt-1`} />
          </label>
          <label className="text-xs text-muted">
            使える PC の台数
            <input
              type="number"
              min={1}
              max={50}
              value={maxDevices}
              onChange={(e) => setMaxDevices(Number(e.target.value) || 1)}
              className={`${input} mt-1`}
            />
          </label>
          <label className="text-xs text-muted">
            期限（任意・空欄で無期限）
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={`${input} mt-1`} />
          </label>
          <label className="text-xs text-muted">
            メモ（任意・相手には見えません）
            <input value={note} onChange={(e) => setNote(e.target.value)} className={`${input} mt-1`} placeholder="例: 平丸さんのお客様" />
          </label>
        </div>
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating || !licensee.trim() || !publicKey}
          className="mt-3 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          発行する
        </button>
        {issued && (
          <div className="mt-3 rounded-lg border border-neon-violet/40 bg-neon-violet/10 p-3 text-xs">
            <p className="text-foreground">{issued.licensee} 様のライセンスキー（この画面を閉じると二度と表示できません。控えてから相手に渡してください）:</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="rounded bg-background px-2 py-1 font-mono text-sm text-neon-violet">{issued.key}</code>
              <button type="button" onClick={() => copy(issued.key)} className="text-muted hover:text-foreground" aria-label="キーをコピー">
                <Copy size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-foreground">発行済み {rows.length} 件</p>
        <button type="button" onClick={() => void load()} className="flex items-center gap-1 text-xs text-muted hover:text-foreground">
          <RefreshCw size={12} /> 再読み込み
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {loading && rows.length === 0 && <p className="text-xs text-muted">読み込み中…</p>}

      <div className="space-y-3">
        {rows.map((lic) => {
          const active = lic.license_activations.filter((a) => !a.revoked_at);
          const expired = lic.expires_at && new Date(lic.expires_at).getTime() <= loadedAt;
          return (
            <article key={lic.id} className={`rounded-xl border border-border p-4 ${lic.revoked_at || expired ? "opacity-60" : "bg-surface/40"}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-neon-pink/15 px-2 py-0.5 font-mono text-neon-pink">{licenseProductLabel(lic.product)}</span>
                <span className="text-sm text-foreground">{lic.licensee} 様</span>
                <span className="font-mono text-muted">キー …{lic.key_hint}</span>
                <span className="text-muted">
                  PC {active.length}/{lic.max_devices} 台
                </span>
                <span className="text-muted">{lic.expires_at ? `期限 ${fmt(lic.expires_at)}` : "無期限"}</span>
                {lic.revoked_at && <span className="text-red-400">停止中</span>}
                {expired && <span className="text-amber-400">期限切れ</span>}
                <button
                  type="button"
                  onClick={() => void patch({ licenseId: lic.id, revoked: !lic.revoked_at })}
                  className="ml-auto rounded-full border border-border px-3 py-1 text-[11px] text-muted hover:text-foreground"
                >
                  {lic.revoked_at ? "再開する" : "停止する"}
                </button>
              </div>
              {(lic.contact || lic.note) && (
                <p className="mt-1 text-xs text-muted">
                  {lic.contact}
                  {lic.contact && lic.note ? "・" : ""}
                  {lic.note}
                </p>
              )}
              <p className="mt-1 text-[11px] text-muted">発行 {fmt(lic.created_at)}</p>
              <LimitsEditor lic={lic} onSave={(maxDevices, expiresAt) => patch({ licenseId: lic.id, maxDevices, expiresAt })} />

              {lic.license_activations.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {lic.license_activations.map((a) => (
                    <li key={a.id} className={`flex flex-wrap items-center gap-2 text-[11px] ${a.revoked_at ? "opacity-50" : ""}`}>
                      <code className="font-mono text-foreground/80" title={a.hwid}>
                        {a.hwid.slice(0, 12)}…
                      </code>
                      <span className="text-muted">{a.method === "manual" ? "手動" : "オンライン"}</span>
                      <span className="text-muted">認証 {fmt(a.activated_at)}・最終確認 {fmt(a.last_seen_at)}</span>
                      {a.revoked_at && <span className="text-red-400">解除済み</span>}
                      <button
                        type="button"
                        onClick={() => void patch({ activationId: a.id, revoked: !a.revoked_at })}
                        className="rounded-full border border-border px-2 py-0.5 text-muted hover:text-foreground"
                      >
                        {a.revoked_at ? "戻す" : "この PC を解除（枠を空ける）"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {!lic.revoked_at && !expired && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={manualHwid[lic.id] ?? ""}
                    onChange={(e) => setManualHwid((m) => ({ ...m, [lic.id]: e.target.value }))}
                    placeholder="手動発行: 相手から届いた HWID を貼り付け"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted/60"
                  />
                  <button
                    type="button"
                    onClick={() => void manualIssue(lic)}
                    disabled={!(manualHwid[lic.id] ?? "").trim()}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-surface disabled:opacity-50"
                  >
                    ライセンスファイルを作る
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
