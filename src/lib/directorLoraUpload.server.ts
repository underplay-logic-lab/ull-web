import "server-only";

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
// 1GB 級の LoRA に数十分かかっていた。R2 へ 32MB ずつ並行に PUT する。保存はしない前提（R2 の 14 日で消える・
// 使うたびに上げ直せばよい、ホスト 2026-10-03）。ワーカーは生成の起動時に署名付き URL から loras/ へ落とす。
export const DIRECTOR_LORA_R2_SUBDIR = "director_user_loras";
export const DIRECTOR_LORA_PART_BYTES = 32 * 1024 * 1024;
export const DIRECTOR_LORA_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** `<root>/director_user_loras/<時刻>-<安全な名前>.safetensors`。名前は ComfyUI の loras/ にそのまま置く。 */
export function directorLoraR2Key(root: string, originalName: string): string {
  const base = originalName.replace(/\.safetensors$/i, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(-60) || "lora";
  return `${root}/${DIRECTOR_LORA_R2_SUBDIR}/${Date.now()}-${base}.safetensors`;
}

/** そのユーザーの置き場所の中の .safetensors だけを通す。 */
export function isOwnedDirectorLoraR2Key(root: string, key: string): boolean {
  const prefix = `${root}/${DIRECTOR_LORA_R2_SUBDIR}/`;
  if (!key.startsWith(prefix)) return false;
  return /^[A-Za-z0-9_-]+\.safetensors$/.test(key.slice(prefix.length));
}
