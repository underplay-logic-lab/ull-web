// Studio タブ間の「この結果を次のタブへ渡す」導線（2026-09-24、ホスト要望）。
//
// Multi-Angle の構図 / Cinematic Director の動画は R2（または Modal）の署名付き
// URL で配信されるので、超解像タブ側で fetch → File にすればローカルから
// 選んだのと同じ入力として扱える。File 自体は storage に置けないため、
// URL とファイル名だけを sessionStorage に置き、タブ切替イベントを投げる。
// 受け取る側はマウント時に 1 回だけ取り出して消す（再読み込みで二重に
// 取り込まない）。Studio.tsx が `ull:studio-tab` を拾って goTab する。

export type StudioHandoffTab = "upscale" | "upscale_video" | "lora";

export type StudioHandoff = {
  kind: "image" | "video";
  url: string;
  filename: string;
  /** 表示用（「マルチアングルの結果を取り込みました」等）。 */
  source: string;
};

const STORAGE_KEY = "ull_studio_handoff";
export const STUDIO_TAB_EVENT = "ull:studio-tab";

export function requestStudioHandoff(handoff: StudioHandoff, tab: StudioHandoffTab): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handoff));
  } catch {
    // private window 等で書けなくてもタブ切替だけは行う（ユーザーは手で選び直せる）。
  }
  window.dispatchEvent(new CustomEvent(STUDIO_TAB_EVENT, { detail: { tab } }));
}

/** 該当 kind の handoff を取り出して消す。無ければ null。 */
export function takeStudioHandoff(kind: StudioHandoff["kind"]): StudioHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudioHandoff>;
    if (parsed.kind !== kind || typeof parsed.url !== "string" || typeof parsed.filename !== "string") return null;
    window.sessionStorage.removeItem(STORAGE_KEY);
    return { kind, url: parsed.url, filename: parsed.filename, source: parsed.source ?? "" };
  } catch {
    return null;
  }
}

/** 署名付き URL を fetch して File にする（R2 / Modal とも CORS は * なので同一処理）。 */
export async function studioHandoffToFile(handoff: StudioHandoff): Promise<File> {
  const res = await fetch(handoff.url);
  if (!res.ok) throw new Error(`取り込みに失敗しました (${res.status})`);
  const blob = await res.blob();
  const fallbackType = handoff.kind === "video" ? "video/mp4" : "image/png";
  const type = blob.type && blob.type !== "application/octet-stream" ? blob.type : fallbackType;
  return new File([blob], handoff.filename, { type });
}

// --- 手元のファイルをまとめて渡す（2026-09-24、LoRA の「小さすぎる素材を超解像へ」）---
// File は sessionStorage に置けないが、タブ切替は同じページ内（SPA）なのでモジュール
// 変数で足りる。リロードを跨ぐ必要は無い（その場合ユーザーは選び直せばよい）。
export type StudioBatchHandoff = {
  files: File[];
  /** 表示用（「LoRA Studio の小さすぎる素材 12 枚を取り込みました」等）。 */
  source: string;
  /** 受け取り側が倍率を選ぶための目標短辺（px）。これ以上になる最小の倍率を初期値にする。 */
  targetShortEdge?: number;
  /**
   * 結果を LoRA Studio へ戻して差し替えるための、元画像の id（files と同じ並び）。
   * あるときだけ超解像タブに「LoRA Studio に戻して差し替える」が出る。
   */
  loraReturnIds?: string[];
  /**
   * 受け取り側の初期モデル（前回使ったモデルより優先）。LoRA 素材は細部を作り直さない
   * 軽量モデル（Real-ESRGAN anime / SwinIR-L）が向く（2026-09-24、ホスト指摘「実写に anime が選ばれている」）。
   */
  suggestedModelKey?: string;
  /** 取り込み通知に添える一言。 */
  hint?: string;
};

let pendingBatch: StudioBatchHandoff | null = null;

export function requestStudioBatchHandoff(handoff: StudioBatchHandoff, tab: StudioHandoffTab): void {
  if (typeof window === "undefined") return;
  pendingBatch = handoff;
  window.dispatchEvent(new CustomEvent(STUDIO_TAB_EVENT, { detail: { tab } }));
}

/** まとめ渡しを取り出して消す。無ければ null。 */
export function takeStudioBatchHandoff(): StudioBatchHandoff | null {
  const h = pendingBatch;
  pendingBatch = null;
  return h;
}

// --- 超解像の結果を LoRA Studio へ戻して差し替える（2026-09-24、ホスト要望）---
// LoRA Studio は一度開くと hidden で残る（Studio.tsx）ので、非表示のままでも
// window のイベントを受け取れる。差し替えを先に投げてからタブを切り替える。
export const LORA_REPLACE_EVENT = "ull:lora-replace";

export type LoraReplacement = { id: string; file: File };

export function sendLoraReplacements(replacements: LoraReplacement[]): void {
  if (typeof window === "undefined" || replacements.length === 0) return;
  window.dispatchEvent(new CustomEvent(LORA_REPLACE_EVENT, { detail: { replacements } }));
  window.dispatchEvent(new CustomEvent(STUDIO_TAB_EVENT, { detail: { tab: "lora" } }));
}

// 超解像ジョブ id → LoRA 側の元画像 id（差し戻し用）。超解像タブは切り替えると unmount される
// ので、component の state に置くと途中で差し戻した瞬間に残りの対応が消える（2026-09-24、
// ホスト指摘）。ページ内（モジュール変数）で持つ。再読み込みで消えるのは LoRA 側の画像も
// 消えるので問題ない。
const loraReturnMap: Record<string, string> = {};

export function getLoraReturnMap(): Record<string, string> {
  return { ...loraReturnMap };
}

export function setLoraReturnEntries(entries: Record<string, string>): void {
  Object.assign(loraReturnMap, entries);
}

export function deleteLoraReturnEntries(jobIds: string[]): void {
  jobIds.forEach((id) => delete loraReturnMap[id]);
}
