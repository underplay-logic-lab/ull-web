import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Public, read-only: lets the Studio UI display the live credits cost per
// generation mode (admin-edited via /admin's Pricing tab) instead of a
// hardcoded number. Only key/credits are exposed — unit_cost_usd (GPU cost,
// used for the admin margin simulator) stays server-side.
export async function GET() {
  const { data, error } = await supabaseAdmin.from("studio_pricing").select("key, credits");

  if (error) {
    console.error("[studio/pricing] fetch failed:", error.message);
    return NextResponse.json({ error: "料金情報の取得に失敗しました。" }, { status: 500 });
  }

  const pricing = Object.fromEntries((data ?? []).map((row) => [row.key as string, row.credits as number]));
  return NextResponse.json({ pricing });
}
