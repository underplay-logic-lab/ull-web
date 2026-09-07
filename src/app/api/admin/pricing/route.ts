import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { DEFAULT_KNOBS, KNOB_META, type KnobKey } from "@/lib/pricing/knobDefaults";

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const [pricingRes, knobsRes] = await Promise.all([
    supabaseAdmin.from("studio_pricing").select("*").order("label", { ascending: true }),
    supabaseAdmin.from("pricing_knobs").select("key, value, updated_at"),
  ]);

  if (pricingRes.error) {
    console.error("[admin/pricing] studio_pricing list failed:", pricingRes.error.message);
    return NextResponse.json({ error: "価格設定の取得に失敗しました。" }, { status: 500 });
  }
  if (knobsRes.error) {
    console.error("[admin/pricing] pricing_knobs list failed:", knobsRes.error.message);
  }

  // Merge the DB overrides onto KNOB_META so a knob that has no row yet (a
  // freshly-added key not in the migration) still shows with its default.
  const dbByKey = new Map(
    (knobsRes.data ?? []).map((r) => [
      r.key as string,
      {
        value: typeof r.value === "string" ? Number(r.value) : (r.value as number),
        updated_at: r.updated_at as string,
      },
    ]),
  );
  const knobs = (Object.keys(KNOB_META) as KnobKey[]).map((key) => {
    const meta = KNOB_META[key];
    const row = dbByKey.get(key);
    return {
      key,
      value: row && Number.isFinite(row.value) ? row.value : DEFAULT_KNOBS[key],
      label: meta.label,
      category: meta.category,
      unit: meta.unit,
      description: meta.description,
      is_public: meta.isPublic,
      updated_at: row?.updated_at ?? null,
      is_default: !row,
    };
  });

  return NextResponse.json({ pricing: pricingRes.data ?? [], knobs });
}
