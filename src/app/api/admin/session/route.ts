import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/adminAuth";

// Lightweight admin-status check for client components (the inline visual
// editor's floating bar). Unlike requireAdmin()'s 403-on-failure, this
// always answers 200 so a normal user's fetch resolves quietly to
// { isAdmin: false } instead of logging a permission error.
export async function GET() {
  const user = await getAdminUser();
  return NextResponse.json({ isAdmin: Boolean(user) });
}
