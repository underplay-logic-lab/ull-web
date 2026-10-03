import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

// ULL Cinematic Director: ユーザーが外部で用意した .safetensors を持ち込んで適用する経路。
// 2026-09-18〜10-03 はブラウザ → Modal（modal_lora_worker.py::upload_user_lora）→ Volume の直送だったが、
// 1 本の接続で遅かったので R2 への分割アップロードに置き換えた（下）。Volume のパスは、その間に作った
// ジョブの「作り直し」で来るので検証だけ残す。

/** クライアントが生成完了後に返してくる Volume相対パスが本人のものである
 * ことを確認する。他人の user_id を騙って渡されても弾く。 */
export function assertOwnedDirectorLoraVolumePath(userId: string, volumePath: string): void {
  if (!volumePath.startsWith(`director_user_loras/${userId}/`)) {
    throw new Error("不正なLoRA指定です。");
  }
}

// --- R2 への分割アップロード（2026-10-03〜）-----------------------------------
// 旧 Modal 直は 1 本の接続で日米を往復するので 1 本あたり約 2.2 Mbps で頭打ちになり（docs/gpu-benchmarks.md §15）、
// 1GB 級の LoRA に数十分かかっていた。R2 へ 32MB ずつ並行に PUT する。ワーカーは生成の起動時に署名付き URL から loras/ へ落とす。
//
// 保存期間（2026-10-04 ホスト判断）: タブを開いている間は使い回し（連続生成のたびに上げ直さない）、タブを閉じたら
// 画面が削除を頼む（/api/director/loras/release、sendBeacon。届かないこともある）。届かなかった分は R2 のライフサイクル
// （scripts/r2_bucket_setup.py の ull-director-loras-1d）が 1 日後に消す。そのためキーは前方一致で指定できるよう
// `director_user_loras/<root>/…` と先頭に置く（ほかの成果物の `<root>/<kind>/…` とは逆）。
export const DIRECTOR_LORA_R2_SUBDIR = "director_user_loras";
export const DIRECTOR_LORA_PART_BYTES = 32 * 1024 * 1024;
export const DIRECTOR_LORA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** `director_user_loras/<root>/<時刻>-<乱数>-<安全な名前>.safetensors`。名前は ComfyUI の loras/ にそのまま置く。 */
export function directorLoraR2Key(root: string, originalName: string): string {
  const base = originalName.replace(/\.safetensors$/i, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(-60) || "lora";
  return `${DIRECTOR_LORA_R2_SUBDIR}/${root}/${Date.now()}-${randomBytes(4).toString("hex")}-${base}.safetensors`;
}

/** そのユーザーの置き場所の中の .safetensors だけを通す。 */
export function isOwnedDirectorLoraR2Key(root: string, key: string): boolean {
  const prefix = `${DIRECTOR_LORA_R2_SUBDIR}/${root}/`;
  if (!key.startsWith(prefix)) return false;
  return /^[A-Za-z0-9_-]+\.safetensors$/.test(key.slice(prefix.length));
}

/** 持ち込み LoRA のキーか（削除依頼で、ほかの置き場所を消させない）。 */
export function isDirectorLoraR2Key(key: string): boolean {
  return /^director_user_loras\/[^/]+\/[A-Za-z0-9_-]+\.safetensors$/.test(key) && !key.includes("..");
}

// タブを閉じるときの削除依頼は sendBeacon で送るので Authorization ヘッダーを付けられない（ログインの期限も切れて
// いることがある）。代わりにアップロード開始時にキーへの署名を渡し、それを持っている画面だけが消せるようにする。
function releaseSecret(): string {
  const s = process.env.MODAL_AUTH_TOKEN;
  if (!s) throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  return s;
}

export function signDirectorLoraRelease(key: string): string {
  return createHmac("sha256", releaseSecret()).update(`director-lora-release:${key}`).digest("hex");
}

export function verifyDirectorLoraRelease(key: string, sig: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(signDirectorLoraRelease(key), "hex"), Buffer.from(sig, "hex"));
}
