import { createClient } from "@/utils/supabase/client";

// Cookie-backed browser client (see utils/supabase/client.ts) so the same
// session is readable server-side in Server Components / Route Handlers via
// utils/supabase/server.ts. Keeps the existing singleton export shape so
// every current `import { supabase } from "@/lib/supabaseClient"` call site
// is unaffected.
export const supabase = createClient();
