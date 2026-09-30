import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";

// Vercel's auto-assigned production domain serves the same site but breaks
// Turnstile (hostname not allowed, error 110200) and splits the login cookie
// from www — send people to the canonical domain (2026-09-30). Only page views:
// /api/* and non-GET requests pass through in case an external service
// (webhooks, worker callbacks) was ever configured with this host.
// Preview deployments (ull-web-git-*.vercel.app etc.) are left alone.
const LEGACY_HOST = "ull-web.vercel.app";
const CANONICAL_ORIGIN = "https://www.ullstudio.com";

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (
    request.headers.get("host") === LEGACY_HOST &&
    (request.method === "GET" || request.method === "HEAD") &&
    !pathname.startsWith("/api/")
  ) {
    return NextResponse.redirect(`${CANONICAL_ORIGIN}${pathname}${search}`, 308);
  }
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every route except static assets and image optimization
     * files, so the auth cookie stays fresh across the whole site (not
     * just /admin) without wasting cycles on _next/static or public/.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4)$).*)",
  ],
};
