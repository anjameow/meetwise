import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

/** True when the Supabase connection has been configured (see .env.example). */
export const supabaseConfigured = !!url && !!key;

// Only the public anon/publishable key is used in the browser. Every
// privileged operation runs in Postgres functions or edge functions.
export const supabase = createClient(url ?? "http://localhost:54321", key ?? "public-anon-key", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
