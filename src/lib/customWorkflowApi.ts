import { supabase } from "@/lib/supabaseClient";
import { uploadUpscaleAsset } from "@/lib/upscaleApi";

export type CustomWorkflowFieldValue = string | number | boolean | File | null;

export type GenerateCustomWorkflowParams = {
  slug: string;
  values: Record<string, CustomWorkflowFieldValue>;
};

export type GenerateCustomWorkflowResult = {
  resultUrl: string;
  outputKind: "image" | "video";
  remainingCredits: number;
  /** 生成完了時点の実効 VRAM 消費量（GB）。ネタバレ防止 — 分母・％・GPU名なし。 */
  vramUsedGb: number | null;
};

export type CustomWorkflowApiError = Error & { remainingCredits?: number };

function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteChars = atob(base64);
  const byteNumbers = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  return new Blob([byteNumbers], { type: mimeType });
}

function mimeTypeFor(filename: string, outputKind: "image" | "video"): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (outputKind === "video") return ext === "webm" ? "video/webm" : "video/mp4";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

export async function generateCustomWorkflow(
  params: GenerateCustomWorkflowParams & { userId: string },
): Promise<GenerateCustomWorkflowResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (!accessToken) {
    throw new Error("ログインが必要です。");
  }

  // 画像/動画フィールドは Supabase Storage へ直接アップロードし、API route
  // には storage path だけを渡す（Vercel の約4.5MBリクエストボディ上限を
  // 回避 — CLAUDE.md §6）。それ以外のスカラー値は通常どおり JSON で送る。
  const scalarValues: Record<string, string | number | boolean> = {};
  const filePaths: Record<string, string> = {};
  for (const [fieldId, value] of Object.entries(params.values)) {
    if (value === null) continue;
    if (value instanceof File) {
      const { path } = await uploadUpscaleAsset(params.userId, value);
      filePaths[fieldId] = path;
    } else {
      scalarValues[fieldId] = value;
    }
  }

  const res = await fetch("/api/studio/custom-workflows/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug: params.slug, values: scalarValues, filePaths }),
  });

  const data = await res.json();

  if (!res.ok) {
    const error: CustomWorkflowApiError = new Error(data?.error || "生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") {
      error.remainingCredits = data.remainingCredits;
    }
    throw error;
  }

  const outputKind = data.outputKind as "image" | "video";
  const resultUrl = URL.createObjectURL(
    base64ToBlob(data.resultBase64, mimeTypeFor(data.filename ?? "", outputKind)),
  );

  return {
    resultUrl,
    outputKind,
    remainingCredits: data.remainingCredits,
    vramUsedGb: typeof data.vramUsedGb === "number" && Number.isFinite(data.vramUsedGb) ? data.vramUsedGb : null,
  };
}
