import { supabase } from "@/lib/supabaseClient";

export type ExtendGpuWarmResult = { warmUntil: string; remainingCredits: number };
export type GpuWarmApiError = Error & { remainingCredits?: number };

export async function extendGpuWarm(): Promise<ExtendGpuWarmResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (!accessToken) {
    throw new Error("ログインが必要です。");
  }

  const res = await fetch("/api/gpu/warm-extend", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();

  if (!res.ok) {
    const error: GpuWarmApiError = new Error(data?.error || "延長に失敗しました。");
    if (typeof data?.remainingCredits === "number") {
      error.remainingCredits = data.remainingCredits;
    }
    throw error;
  }

  return { warmUntil: data.warmUntil as string, remainingCredits: data.remainingCredits as number };
}
