import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Cinematic Director の LoRA ピッカー用一覧: 現在のユーザーが LoRA Studio で
// 完了させた MiniMax H3 (arch: "minimax_h3") の LoRA を返す。
// modal_lora_worker.py の「Directory contract」により、完了した LoRA は
// 必ず loras/<output_lora_name>.safetensors としても保存される（ComfyUI の
// LoraLoaderModelOnly がファイル名だけで解決できるエイリアス）ので、ここでは
// その output_lora_name だけを返せば良い（バイト自体は一切扱わない）。
export const maxDuration = 15;

export async function GET(request: Request): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "サーバー設定エラーです。" }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }

  // CLAUDE.md §3: 生成された LoRA は一律14日で自動パージされる
  // (modal_retention_purge.py の RETENTION_DAYS、created_at 起点)。DB行自体は
  // パージのタイミング次第で少し遅れて残ることがある（実機確認済み — created_at
  // が14日前ちょうどの行で、Volume上の loras/<name>.safetensors は既に消えて
  // いた）ため、ここでも同じ cutoff で明示的に足切りしないと、実体の無い
  // LoRA をユーザーに選ばせてしまう。
  const retentionCutoffIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("generation_jobs")
    .select("id, inputs, completed_at, created_at")
    .eq("user_id", userData.user.id)
    .eq("workflow_type", "lora_training")
    .eq("status", "completed")
    .eq("inputs->>target_model", "minimax_h3")
    .gte("created_at", retentionCutoffIso)
    .order("completed_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[director/loras] query failed:", error.message);
    return NextResponse.json({ error: "LoRA一覧の取得に失敗しました。" }, { status: 500 });
  }

  const seen = new Set<string>();
  const loras: { id: string; label: string }[] = [];
  for (const row of data ?? []) {
    const inputs = row.inputs as Record<string, unknown> | null;
    const name = typeof inputs?.output_lora_name === "string" ? inputs.output_lora_name : "";
    const triggerWord = typeof inputs?.trigger_word === "string" ? inputs.trigger_word : null;
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    loras.push({ id: name, label: triggerWord ? `${name} (${triggerWord})` : name });
  }

  return NextResponse.json({ loras });
}
