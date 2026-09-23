// Studio タブ間の「この結果を次のタブへ渡す」導線（2026-09-24、ホスト要望）。
//
// Multi-Angle の構図 / Cinematic Director の動画は R2（または Modal）の署名付き
// URL で配信されるので、超解像タブ側で fetch → File にすればローカルから
// 選んだのと同じ入力として扱える。File 自体は storage に置けないため、
// URL とファイル名だけを sessionStorage に置き、タブ切替イベントを投げる。
// 受け取る側はマウント時に 1 回だけ取り出して消す（再読み込みで二重に
// 取り込まない）。Studio.tsx が `ull:studio-tab` を拾って goTab する。

export type StudioHandoffTab = "upscale" | "upscale_video";

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
