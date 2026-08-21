import { supabase } from "@/lib/supabaseClient";

export type WanAnimateGenerateParams = {
  characterImage: File;
  motionMode: "preset" | "custom";
  presetId?: string | null;
  customMotionVideo?: File | null;
  prompt: string;
};

export type WanAnimateGenerateResult = {
  videoUrl: string;
  remainingCredits: number;
};

export type WanAnimateApiError = Error & { remainingCredits?: number };

function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteChars = atob(base64);
  const byteNumbers = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  return new Blob([byteNumbers], { type: mimeType });
}

export async function generateWanAnimateVideo(
  params: WanAnimateGenerateParams,
): Promise<WanAnimateGenerateResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (!accessToken) {
    throw new Error("ログインが必要です。");
  }

  const formData = new FormData();
  formData.append("characterImage", params.characterImage);
  formData.append("motionMode", params.motionMode);
  if (params.motionMode === "preset" && params.presetId) {
    formData.append("presetId", params.presetId);
  }
  if (params.motionMode === "custom" && params.customMotionVideo) {
    formData.append("customMotionVideo", params.customMotionVideo);
  }
  formData.append("prompt", params.prompt);

  const res = await fetch("/api/wan-animate/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });

  const data = await res.json();

  if (!res.ok) {
    const error: WanAnimateApiError = new Error(data?.error || "動画生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") {
      error.remainingCredits = data.remainingCredits;
    }
    throw error;
  }

  const videoUrl = URL.createObjectURL(base64ToBlob(data.videoBase64, "video/mp4"));

  return { videoUrl, remainingCredits: data.remainingCredits };
}
