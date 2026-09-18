import { supabase } from "@/lib/supabaseClient";
import { normalizeAngleReferenceImage } from "@/lib/angleImage";
import { uploadStudioAsset } from "@/lib/studioUploads";
import type { AngleMode, AngleSelection } from "@/lib/angleStudio";

export type AngleApiError = Error & { remainingCredits?: number };

/** ジョブ行が見つからない（14日保持を過ぎて自動 purge 済み等）— 一時的な
 * 通信エラーと違いリトライしても直らないので、呼び出し側で区別して案内する。 */
export class AngleJobNotFoundError extends Error {
  constructor() {
    super("ジョブが見つかりません。");
    this.name = "AngleJobNotFoundError";
  }
}

export type AngleJobStatus = "pending" | "processing" | "completed" | "failed";

export type AngleJob = {
  id: string;
  status: AngleJobStatus;
  mode: AngleMode;
  totalAngles: number;
  completedAngles: number;
  /** 生成済み画像の公開 URL（生成順）。 */
  images: string[];
  /** images と並行な日本語構図ラベル。 */
  labels: string[];
  errorMessage: string | null;
  /** ライブ実効 VRAM 消費量（GB）。ネタバレ防止 — 分母・％・GPU名なし。
   *  worker 未デプロイ／CUDA 無しなら null。 */
  vramUsedGb: number | null;
};

export type StartAngleJobResult = {
  jobId: string;
  totalAngles: number;
  remainingCredits: number;
};

/**
 * 構図マトリクスを一括でジョブ投入する。1 秒以内に jobId を返し、以降は
 * pollAngleJob で進捗を追う（サーバー / ブラウザのタイムアウトから完全に独立）。
 * reroll（1 構図だけ別シード再生成）も、combo 1 個ぶんの selection を渡すだけ。
 */
export async function startAngleJob(params: {
  userId: string;
  image: File;
  /** Multi-Reference（Pro）: 死角補完用のサブ参照画像（背面ラフ・衣装パーツ等）。
   *  最大 MAX_SUB_REFERENCE_IMAGES 枚。省略時は従来どおりの単一画像生成。 */
  subImages?: File[];
  selection: AngleSelection;
  mode: AngleMode;
  /** reroll 用: 指定すると worker が seed + index で分散させる。 */
  seed?: number;
  /** true: 実行中のジョブを待たず並列で今すぐ実行（追加料金）。既定 false = 順番待ち。 */
  priority?: boolean;
}): Promise<StartAngleJobResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  // 長辺 1536px へ縮小・再エンコードしてから、Supabase Storage へ直接
  // アップロードする（Vercel の約4.5MBリクエストボディ上限を回避 —
  // CLAUDE.md §6）。サブ参照画像も同じ正規化を通す。
  const { blob: imageBlob, filename } = await normalizeAngleReferenceImage(params.image);
  const subs = await Promise.all(
    (params.subImages ?? []).map((f) => normalizeAngleReferenceImage(f)),
  );

  const mainFile = new File([imageBlob], filename, { type: imageBlob.type });
  const { path: mainPath } = await uploadStudioAsset(params.userId, mainFile);
  const subPaths: string[] = [];
  for (let i = 0; i < subs.length; i++) {
    const subFile = new File([subs[i].blob], subs[i].filename || `sub_${i}.png`, {
      type: subs[i].blob.type,
    });
    const { path } = await uploadStudioAsset(params.userId, subFile);
    subPaths.push(path);
  }

  const res = await fetch("/api/studio/angle/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      storagePaths: [mainPath, ...subPaths],
      selection: params.selection,
      mode: params.mode,
      seed: params.seed,
      priority: params.priority ?? false,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const error: AngleApiError = new Error(data?.error || "ジョブの作成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    throw error;
  }

  return {
    jobId: data.jobId as string,
    totalAngles: data.totalAngles as number,
    remainingCredits: data.remainingCredits as number,
  };
}

type AngleJobRow = {
  id: string;
  status: AngleJobStatus;
  mode: string;
  total_angles: number;
  completed_angles: number;
  images: unknown;
  labels: unknown;
  error_message: string | null;
  metadata: unknown;
};

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// images配列の要素がURLではなくVolume相対パス（Multi-Angle結果、
// 2026-09-18〜の新方式）かどうかを判定する。移行前の旧行（Supabase公開
// URL）やDB書き込み失敗時のdata URIフォールバックはそのままfalseになる。
function isAngleImageVolumePath(v: string): boolean {
  return !/^https?:\/\//i.test(v) && !v.startsWith("data:");
}

// Volume相対パス文字列 -> 署名付きModal URL のキャッシュ。署名は15分間
// 有効で、Multi-Angleジョブは通常その範囲内に完了するため、同じ画像を
// ポーリングのたびに毎回再署名しにいくのを避ける（CLAUDE.md §1）。
const _angleImageUrlCache = new Map<string, string>();

/** /api/studio/angle/images でジョブ1件ぶんのimages配列を丸ごと解決する。 */
async function fetchAngleImageUrls(jobId: string): Promise<string[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const url = new URL("/api/studio/angle/images", window.location.origin);
  url.searchParams.set("jobId", jobId);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data?.images)) {
    throw new Error(data?.error || "画像URLの発行に失敗しました。");
  }
  return data.images as string[];
}

/** rawImages（DBから読んだそのままの値、Volume相対パスを含みうる）を、
 * 表示・ダウンロードに使える実URLの配列へ解決する。未解決の要素が1つも
 * 無ければAPIを呼ばずそのまま返す（ポーリングのたびの無駄な呼び出しを
 * 避ける）。 */
async function resolveAngleImages(jobId: string, rawImages: string[]): Promise<string[]> {
  if (rawImages.length === 0) return rawImages;
  const needsResolve = rawImages.some(
    (v) => isAngleImageVolumePath(v) && !_angleImageUrlCache.has(v),
  );
  if (needsResolve) {
    try {
      const resolved = await fetchAngleImageUrls(jobId);
      resolved.forEach((url, i) => {
        const raw = rawImages[i];
        if (raw && isAngleImageVolumePath(raw)) _angleImageUrlCache.set(raw, url);
      });
    } catch (err) {
      console.warn("[angleApi] resolveAngleImages failed:", err);
    }
  }
  return rawImages.map((v) => (isAngleImageVolumePath(v) ? (_angleImageUrlCache.get(v) ?? v) : v));
}

function metaNumber(meta: unknown, key: string): number | null {
  if (!meta || typeof meta !== "object") return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * angle_jobs 行を直接読む（owner RLS）。API ルートを経由しないので軽く、
 * Vercel の関数実行にも一切依存しない。
 */
const ANGLE_COLS_BASE =
  "id, status, mode, total_angles, completed_angles, images, labels, error_message";

export async function pollAngleJob(jobId: string): Promise<AngleJob> {
  // metadata 列は 20260853000000 マイグレーションで追加。まだ適用されていない
  // 環境（フロント先行デプロイ）でも壊れないよう、列不在エラーなら metadata
  // 抜きで一度だけ retry する。
  let { data, error } = await supabase
    .from("angle_jobs")
    .select(`${ANGLE_COLS_BASE}, metadata`)
    .eq("id", jobId)
    .single<AngleJobRow>();

  if (error && /metadata/.test(error.message)) {
    ({ data, error } = await supabase
      .from("angle_jobs")
      .select(ANGLE_COLS_BASE)
      .eq("id", jobId)
      .single<AngleJobRow>());
  }

  // .single() は 0 件でも PGRST116 でエラーを返す（profile.ts と同じ規約）。
  if (error?.code === "PGRST116") throw new AngleJobNotFoundError();
  if (error) throw new Error(error.message);
  if (!data) throw new AngleJobNotFoundError();

  const rawImages = toStringArray(data.images);
  const images = await resolveAngleImages(jobId, rawImages);

  return {
    id: data.id,
    status: data.status,
    mode: "standard",
    totalAngles: data.total_angles ?? 0,
    completedAngles: data.completed_angles ?? 0,
    images,
    labels: toStringArray(data.labels),
    errorMessage: data.error_message,
    vramUsedGb: metaNumber(data.metadata, "vram_used_gb"),
  };
}

/** 公開 URL / data URI を実ファイルとして保存させる（cross-origin download 対策）。 */
export async function downloadAngleImage(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`画像の取得に失敗しました (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
