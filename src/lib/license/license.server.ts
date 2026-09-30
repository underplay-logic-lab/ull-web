import "server-only";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";

// 納品ツールのライセンス（2026-09-30、ホスト要望: 手元で動かすツールを「その人の PC だけ」で動かす）。
//
// 流れ: admin がライセンスを発行（キーを相手に渡す）→ ツールが初回起動時にキーと HWID を /api/license/activate へ →
// サーバーが Ed25519 で署名したライセンスファイル（トークン）を返す → ツールは同梱の公開鍵で検証して起動する。
//
// 方針（2026-09-30 ホスト判断）: **オンライン専用**。
//  - 再確認: RECHECK_DAYS ごとに試み（つながらなければそのまま）、HARD_CHECK_DAYS 確認できなければ止める
//    （移し替えた古い PC がオフラインで動き続ける抜け道を塞ぐ。ネットにつなげばすぐ再開）。
//  - 移し替え: 台数が上限のとき、ツールが確認のうえ transfer:true で認証し直すと古い PC（オンライン認証のもの）を外して移す。
//    TRANSFER_COOLDOWN_DAYS に 1 回まで。超えたら連絡 → admin で解除。
//  - 試用: キー無しで products.ts の trialDays 日（1 台 1 回、license_trials に記録）。試用中は起動のたびにオンラインで確かめる
//    （時計を戻して延ばされないよう、期限はサーバーの時刻で判定）。
//  - admin の「手動発行」は非常用（通信が止められる環境など）。再確認なしのトークンを返す。
//
// トークン形式: "ULL1." + base64url(JSON payload) + "." + base64url(Ed25519 署名（"ULL1." + payload 部分の ASCII に対して）)
// Python 側の検証は tools/ull_license/ull_license.py（純 Python の Ed25519）。形式を変えるときは両方を直す。

export const TOKEN_PREFIX = "ULL1.";
export const RECHECK_DAYS = 1;
export const HARD_CHECK_DAYS = 7;
export const TRANSFER_COOLDOWN_DAYS = 30;

export type LicensePayload = {
  v: 1;
  /** "license"（キーで認証）/ "trial"（試用）。古いトークンに無ければ license 扱い */
  kind?: "license" | "trial";
  /** licenses.id（試用は "trial"） */
  lid: string;
  /** license_activations.id（試用は license_trials.id） */
  aid: string;
  product: string;
  /** 管理用の名義（admin で誰に発行したかを見分ける呼び名。今はツール画面には出していない） */
  licensee: string;
  /** ツールが送った HWID（sha256 hex） */
  hwid: string;
  /** 発行時刻（unix 秒） */
  iat: number;
  /** ライセンスの期限（unix 秒）。無期限は null */
  exp: number | null;
  /** この時刻を過ぎたらオンラインで再確認を試みる（unix 秒）。つながらなければそのまま動く。手動発行は null */
  rck: number | null;
  /** この時刻を過ぎたら再確認できるまで止める（unix 秒）。手動発行は null */
  hck?: number | null;
  /** true なら起動のたびにオンラインで確かめる（試用） */
  chk?: boolean;
};

let cachedKey: KeyObject | null = null;

// LICENSE_SIGNING_KEY = Ed25519 秘密鍵の PKCS8 DER を base64 にしたもの（scripts/generate-license-keypair.mjs で作る）。
function signingKey(): KeyObject {
  if (cachedKey) return cachedKey;
  const b64 = process.env.LICENSE_SIGNING_KEY;
  if (!b64) throw new Error("Missing LICENSE_SIGNING_KEY environment variable.");
  cachedKey = createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
  return cachedKey;
}

/** ツールに埋め込む公開鍵（生の 32 バイトを base64）。 */
export function publicKeyBase64(): string {
  const spki = createPublicKey(signingKey()).export({ format: "der", type: "spki" });
  // Ed25519 の SPKI DER は 12 バイトのヘッダ + 32 バイトの鍵。
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function signToken(payload: LicensePayload): string {
  const head = TOKEN_PREFIX + b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = sign(null, Buffer.from(head, "ascii"), signingKey());
  return `${head}.${b64url(sig)}`;
}

/** 署名が正しければ payload、そうでなければ null（期限は見ない。呼び出し側で DB と照合する）。 */
export function verifyToken(token: string): LicensePayload | null {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= TOKEN_PREFIX.length) return null;
  const head = token.slice(0, dot);
  try {
    const ok = verify(
      null,
      Buffer.from(head, "ascii"),
      createPublicKey(signingKey()),
      Buffer.from(token.slice(dot + 1), "base64url"),
    );
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(head.slice(TOKEN_PREFIX.length), "base64url").toString("utf8"));
    return payload?.v === 1 ? (payload as LicensePayload) : null;
  } catch {
    return null;
  }
}

// ライセンスキー: "ULL-XXXXX-XXXXX-XXXXX-XXXXX"（Crockford 風 base32・紛らわしい文字なし、100 bit）。
// DB には sha256 だけを残す（漏れても使えない）。原文は発行直後に一度だけ admin に見せる。
const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateLicenseKey(): string {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (b) => KEY_ALPHABET[b & 31]);
  const groups = [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join(""));
  return `ULL-${groups.join("-")}`;
}

/** 入力の揺れ（小文字・ハイフンや空白の有無・"ULL-" の有無・O/0・I/L/1）を吸収してからハッシュする。 */
export function normalizeLicenseKey(key: string): string {
  return key
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/^ULL/, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

export function hashLicenseKey(key: string): string {
  return createHash("sha256").update(normalizeLicenseKey(key)).digest("hex");
}

export const HWID_RE = /^[0-9a-f]{64}$/;

export function normalizeHwid(hwid: unknown): string | null {
  if (typeof hwid !== "string") return null;
  const h = hwid.replace(/[\s-]/g, "").toLowerCase();
  return HWID_RE.test(h) ? h : null;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
