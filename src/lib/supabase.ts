import { createClient } from "@supabase/supabase-js";

// Injected at build time by vite.config.ts (see .env.example for the names).
const url = __SUPABASE_URL__ || undefined;
const key = __SUPABASE_PUBLIC_KEY__ || undefined;

/** True when the Supabase connection has been configured (see .env.example). */
export const supabaseConfigured = !!url && !!key;

// Only the public anon/publishable key is used in the browser. Every
// privileged operation runs in Postgres functions or edge functions.
export const supabase = createClient(url ?? "http://localhost:54321", key ?? "public-anon-key", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
