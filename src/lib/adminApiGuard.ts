import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { getAdminUser } from "@/lib/adminAuth";

type RequireAdminResult =
  | { user: User; response: null }
  | { user: null; response: NextResponse };

// Every /api/admin/* route calls this first — the client-side layout guard
// keeps non-admins off the page, but the API itself must not trust that.
export async function requireAdmin(): Promise<RequireAdminResult> {
  const user = await getAdminUser();
  if (!user) {
    return {
      user: null,
      response: NextResponse.json({ error: "権限がありません。" }, { status: 403 }),
    };
  }
  return { user, response: null };
}
