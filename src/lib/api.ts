import { supabase } from "./supabase";
import { AppError } from "./errors";

/** Call a Postgres RPC. Throws AppError with the server's error code. */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new AppError(error.message, error.message);
  // Some functions return {error} instead of raising, so the attempt still
  // counts towards rate limits.
  if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as any).error === "string") {
    throw new AppError((data as any).error);
  }
  return data as T;
}

/** Invoke an edge function with the user's session. */
export async function invoke<T = any>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let code = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === "function") code = (await ctx.json()).error ?? code;
    } catch { /* keep generic */ }
    throw new AppError(code);
  }
  return data as T;
}

export function avatarUrl(path?: string | null): string | null {
  if (!path) return null;
  return supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
}
