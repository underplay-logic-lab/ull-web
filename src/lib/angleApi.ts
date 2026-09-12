import { supabase } from "@/lib/supabaseClient";
import { normalizeAngleReferenceImage } from "@/lib/angleImage";
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
  image: File;
  /** Multi-Reference（Pro）: 死角補完用のサブ参照画像（背面ラフ・衣装パーツ等）。
   *  最大 MAX_SUB_REFERENCE_IMAGES 枚。省略時は従来どおりの単一画像生成。 */
  subImages?: File[];
  selection: AngleSelection;
  mode: AngleMode;
  /** reroll 用: 指定すると worker が seed + index で分散させる。 */
  seed?: number;
}): Promise<StartAngleJobResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  // 生画像をそのまま送るとデプロイ環境のボディ上限でボディが打ち切られ、
  // サーバーの request.formData() が壊れる（=「リクエストの形式が正しく
  // ありません。」400）。長辺 1536px へ縮小・再エンコードしてから送る。
  // サブ参照画像も同じ正規化を通す。
  const { blob: imageBlob, filename } = await normalizeAngleReferenceImage(params.image);
  const subs = await Promise.all(
    (params.subImages ?? []).map((f) => normalizeAngleReferenceImage(f)),
  );

  const form = new FormData();
  form.append("image", imageBlob, filename);
  for (let i = 0; i < subs.length; i++) {
    form.append("subImage", subs[i].blob, subs[i].filename || `sub_${i}.png`);
  }
  form.append("selection", JSON.stringify(params.selection));
  form.append("mode", params.mode);
  if (typeof params.seed === "number") form.append("seed", String(params.seed));

  const res = await fetch("/api/studio/angle/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
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

  return {
    id: data.id,
    status: data.status,
    mode: "standard",
    totalAngles: data.total_angles ?? 0,
    completedAngles: data.completed_angles ?? 0,
    images: toStringArray(data.images),
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
