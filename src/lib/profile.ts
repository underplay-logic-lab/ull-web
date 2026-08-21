import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Mirrors the marketing copy ("新規アカウント登録で即時10クレジット無料進呈")
// — used only to self-heal a profile row that should already exist but
// doesn't, e.g. because the signup trigger that normally creates it hasn't
// run yet, failed, or predates a user created before it existed.
const SIGNUP_BONUS_CREDITS = 10;
const CREDIT_VALIDITY_DAYS = 180;

// `data`'s fields are left as `unknown` (cast at each call site): `columns`
// is a caller-supplied string, not a literal, so there's no static column
// list to type it against — making `columns` a generic type parameter
// instead, to let Supabase infer columns from a literal, blows up the
// TypeScript compiler on this query.
type ProfileResult = { data: Record<string, unknown> | null; error: PostgrestError | null };

// Supabase's `.single()` errors with PGRST116 ("no rows returned") when an
// authenticated user has no matching profiles row. Rather than failing the
// request, create the missing row on the fly and continue.
// `signal` lets a caller bound the total time spent here (e.g. the
// daily-bonus route, which must never let a slow/hanging DB round-trip
// stall the post-login UX) — each query aborts individually rather than
// the whole function hanging on whichever step is slow.
export async function getOrCreateProfile(
  userId: string,
  columns: string,
  signal?: AbortSignal,
): Promise<ProfileResult> {
  // Cast away the `select()` overload's literal-string parsing: `columns`
  // is a runtime string, not a type-level literal, so there's nothing for
  // it to infer field types from anyway. abortSignal() must be applied
  // before .single() — it's a filter-builder method, not available on the
  // single-row builder .single() returns.
  let selectQuery = supabaseAdmin.from("profiles").select(columns).eq("id", userId);
  if (signal) selectQuery = selectQuery.abortSignal(signal);
  const first = (await selectQuery.single()) as unknown as ProfileResult;

  if (!first.error || first.error.code !== "PGRST116") {
    return first;
  }

  let insertQuery = supabaseAdmin.from("profiles").insert({
    id: userId,
    credits: SIGNUP_BONUS_CREDITS,
    credits_expire_at: new Date(
      Date.now() + CREDIT_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
    subscription_tier: "free",
  });
  if (signal) insertQuery = insertQuery.abortSignal(signal);
  const { error: insertError } = await insertQuery;

  // 23505 = unique_violation: another concurrent request already created
  // the row between our select and insert — just re-read it.
  if (insertError && insertError.code !== "23505") {
    console.error("[getOrCreateProfile] failed to create profile:", insertError.message);
    return { data: null, error: insertError };
  }

  let reselectQuery = supabaseAdmin.from("profiles").select(columns).eq("id", userId);
  if (signal) reselectQuery = reselectQuery.abortSignal(signal);
  return (await reselectQuery.single()) as unknown as ProfileResult;
}
