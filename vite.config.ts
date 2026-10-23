import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// The Supabase URL and public key can come from our own VITE_* names or from
// the names Vercel's / Supabase's integrations create. Only the public
// (anon / publishable) key is ever read; a secret key fails the build.
function supabaseEnv(mode: string) {
  const env: Record<string, string | undefined> = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const url = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || "";
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY
    || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
  let role: string | undefined;
  try { role = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString()).role; } catch { /* not a JWT */ }
  if (key.startsWith("sb_secret_") || role === "service_role") {
    throw new Error("A Supabase SECRET key was provided as the public key. Use the anon / publishable key instead.");
  }
  return { url, key };
}

export default defineConfig(({ mode }) => {
  const { url, key } = supabaseEnv(mode);
  return {
    server: { host: "::", port: 8080 },
    plugins: [react()],
    resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
    define: { __SUPABASE_URL__: JSON.stringify(url), __SUPABASE_PUBLIC_KEY__: JSON.stringify(key) },
  };
});
