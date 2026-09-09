import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { invalidatePricingKnobs } from "@/lib/pricing/knobs.server";
import { KNOB_META, type KnobKey } from "@/lib/pricing/knobDefaults";

type RouteParams = { params: Promise<{ key: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const { key } = await params;
  if (!(key in KNOB_META)) {
    return NextResponse.json({ error: "不明な単価キーです。" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const value = body && typeof body === "object" ? (body as { value?: unknown }).value : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return NextResponse.json({ error: "値は 0 以上の数値で入力してください。" }, { status: 400 });
  }

  const meta = KNOB_META[key as KnobKey];
  const { data, error } = await supabaseAdmin
    .from("pricing_knobs")
    .upsert(
      {
        key,
        value,
        label: meta.label,
        category: meta.category,
        unit: meta.unit,
        description: meta.description,
        is_public: meta.isPublic,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    )
    .select("key, value, updated_at")
    .single();

  if (error) {
    console.error("[admin/pricing/knobs] update failed:", error.message);
    return NextResponse.json({ error: "単価の更新に失敗しました。" }, { status: 500 });
  }

  invalidatePricingKnobs();
  return NextResponse.json({
    knob: {
      key: data.key,
      value: typeof data.value === "string" ? Number(data.value) : data.value,
      updated_at: data.updated_at,
      is_default: false,
    },
  });
}
