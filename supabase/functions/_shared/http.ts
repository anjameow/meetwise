// Edge-function helpers (Deno). The service-role key is read from the function
// environment and never leaves the server.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Rpc } from "./engine.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err);
  const status = /forbidden|not_authenticated/.test(message) ? 403
    : /not_found/.test(message) ? 404
    : /confirmation_required|already_running|invalid_transition|registration_still_open|rerun_after_reveal|event_paused|primary_round_required/.test(message) ? 409
    : /invalid_input/.test(message) ? 400 : 500;
  return json({ error: message }, status);
}

const url = () => Deno.env.get("SUPABASE_URL")!;

export function serviceClient(): SupabaseClient {
  return createClient(url(), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

/** Client acting as the caller, so auth.uid() and RLS apply. */
export function userClient(req: Request): SupabaseClient {
  return createClient(url(), Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
}

export async function requireUser(req: Request) {
  const client = userClient(req);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("not_authenticated");
  return { client, user: data.user };
}

export function rpcOf(client: SupabaseClient): Rpc {
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  };
}

export async function requireOrganiser(req: Request, eventId: string) {
  const { client, user } = await requireUser(req);
  const ok = await rpcOf(client)("is_event_organiser", { p_event: eventId });
  if (ok !== true) throw new Error("forbidden");
  return user;
}

export function handleOptions(req: Request) {
  return req.method === "OPTIONS" ? new Response("ok", { headers: corsHeaders }) : null;
}
