import "server-only";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";

export function getAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

// Resolves the current session's user and confirms their email is on the
// ADMIN_EMAILS allowlist. Returns null for both "not logged in" and
// "logged in but not an admin" — callers redirect/403 either way.
export async function getAdminUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) return null;

  const adminEmails = getAdminEmails();
  if (!adminEmails.includes(user.email.toLowerCase())) return null;

  return user;
}
