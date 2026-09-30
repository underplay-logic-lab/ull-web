// 納品ツールのライセンス署名鍵（Ed25519）を 1 回だけ作る（2026-09-30）。
//
//   node scripts/generate-license-keypair.mjs
//
// .env.local に LICENSE_SIGNING_KEY（秘密鍵 PKCS8 DER の base64）を追記し、ツールに埋め込む公開鍵だけを表示する。
// 秘密鍵は画面に出さない。Vercel の環境変数（種類は Sensitive）にも同じ値を入れること。
// 既に LICENSE_SIGNING_KEY があれば何もしない（作り直すと配布済みのツール・ライセンスが全部使えなくなる）。

import { appendFileSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
const current = readFileSync(envPath, "utf8");
if (/^\s*LICENSE_SIGNING_KEY\s*=/m.test(current)) {
  console.log("LICENSE_SIGNING_KEY は既に .env.local にあります。作り直しはしません。");
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const spki = publicKey.export({ format: "der", type: "spki" });
const pub = Buffer.from(spki.subarray(spki.length - 32)).toString("base64");

appendFileSync(envPath, `${current.endsWith("\n") ? "" : "\n"}# 納品ツールのライセンス署名鍵（scripts/generate-license-keypair.mjs）\nLICENSE_SIGNING_KEY=${priv}\n`);
console.log("LICENSE_SIGNING_KEY を .env.local に追記しました（Vercel にも同じ値を入れてください）。");
console.log(`公開鍵（ツールに埋め込む）: ${pub}`);
