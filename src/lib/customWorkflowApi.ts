import { supabase } from "@/lib/supabaseClient";

export type CustomWorkflowFieldValue = string | number | boolean | File | null;

export type GenerateCustomWorkflowParams = {
  slug: string;
  values: Record<string, CustomWorkflowFieldValue>;
};

export type GenerateCustomWorkflowResult = {
  resultUrl: string;
  outputKind: "image" | "video";
  remainingCredits: number;
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
  params: GenerateCustomWorkflowParams,
): Promise<GenerateCustomWorkflowResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (!accessToken) {
    throw new Error("ログインが必要です。");
  }

  const formData = new FormData();
  formData.append("slug", params.slug);
  for (const [fieldId, value] of Object.entries(params.values)) {
    if (value === null) continue;
    formData.append(`field:${fieldId}`, value instanceof File ? value : String(value));
  }

  const res = await fetch("/api/studio/custom-workflows/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
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

  return { resultUrl, outputKind, remainingCredits: data.remainingCredits };
}
