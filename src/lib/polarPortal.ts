import { supabase } from "@/lib/supabaseClient";

// Shared by every "manage / cancel subscription" entry point (Header gear,
// Pricing manage button). Hits /api/portal/polar, which mints a Polar
// customer-portal session and returns its URL, then navigates there. On
// failure it resolves with an error message for the caller to surface —
// it never throws.
export async function openPolarPortal(): Promise<{ ok: boolean; error?: string }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return { ok: false, error: "ログインが必要です。" };
  }

  let res: Response;
  try {
    res = await fetch("/api/portal/polar", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { ok: false, error: "通信エラーが発生しました。時間をおいて再度お試しください。" };
  }

  const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;

  if (!res.ok || !data?.url) {
    return { ok: false, error: data?.error || "管理画面を開けませんでした。" };
  }

  window.location.assign(data.url);
  return { ok: true };
}
