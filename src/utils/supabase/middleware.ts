import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Runs on every request from proxy.ts to refresh the auth session cookie
// before it expires. Without this, a Server Component's getUser() call can
// only read a stale/expired token and never sees the refreshed one, since
// Server Components can't write cookies themselves.
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Do not remove: revalidates the token and triggers a cookie refresh when
  // needed. Reading `session` directly here would use a possibly-stale
  // cached value instead of hitting the Supabase auth server.
  await supabase.auth.getUser();

  return response;
}
