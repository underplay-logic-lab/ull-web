import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables.",
  );
}

// Browser client: persists the session in cookies (not localStorage) so
// Server Components / Route Handlers / Proxy can read the same session via
// utils/supabase/server.ts. No `cookies` option needed — createBrowserClient
// falls back to document.cookie automatically.
export function createClient() {
  return createBrowserClient(supabaseUrl!, supabaseAnonKey!);
}
