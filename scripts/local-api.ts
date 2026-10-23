// LOCAL DEVELOPMENT ONLY. A small stand-in for the Supabase HTTP APIs
// (Auth, PostgREST, Storage, Edge Functions) running on top of the local
// PostgreSQL started by scripts/local-db.sh, so the real migrations, RLS and
// RPCs can be exercised from the browser without Docker. It implements only
// the subset of each API that the Meetwise frontend uses. Production uses
// real Supabase; nothing here is deployed.
//
//   bash scripts/local-db.sh && npx tsx scripts/local-api.ts
//   VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_PUBLISHABLE_KEY=<printed anon key> npm run dev
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { previewMatching, runMatchingJob, runRecommendationJob, runSchedulerPass, type Rpc } from "../supabase/functions/_shared/engine.ts";

const PORT = Number(process.env.LOCAL_API_PORT ?? 54321);
const SECRET = "local-dev-jwt-secret-not-for-production";
const STORAGE_DIR = process.env.LOCAL_STORAGE_DIR ?? "/tmp/meetwise-storage";
const pool = new pg.Pool({ host: "/tmp", port: Number(process.env.MEETWISE_PGPORT ?? 54329), user: "postgres", database: "meetwise", max: 10 });

// ---------------------------------------------------------------- JWT
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function sign(claims: Record<string, unknown>) {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  const sig = b64(crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
function verify(token: string | undefined): Record<string, any> | null {
  if (!token) return null;
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return null;
  const expect = b64(crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest());
  if (expect !== s) return null;
  const claims = JSON.parse(Buffer.from(b, "base64url").toString());
  if (claims.exp && claims.exp < Date.now() / 1000) return null;
  return claims;
}
export const ANON_KEY = sign({ role: "anon", iss: "meetwise-local" });
export const SERVICE_KEY = sign({ role: "service_role", iss: "meetwise-local" });

// ---------------------------------------------------------------- DB helpers
type Role = "anon" | "authenticated" | "service_role";
async function asRole<T>(role: Role, claims: Record<string, unknown>, fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally { c.release(); }
}
const enc = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);
async function callRpc(role: Role, claims: Record<string, unknown>, fn: string, args: Record<string, unknown>) {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw Object.assign(new Error("invalid function"), { code: "PGRST202" });
  const keys = Object.keys(args).filter((k) => /^[a-z_][a-z0-9_]*$/.test(k));
  return asRole(role, claims, async (c) => {
    const r = await c.query(`select to_jsonb(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})) as r`, keys.map((k) => enc(args[k])));
    return r.rows[0]?.r ?? null;
  });
}
const serviceRpc: Rpc = (fn, args) => callRpc("service_role", { role: "service_role" }, fn, args ?? {});

function identify(req: http.IncomingMessage): { role: Role; claims: Record<string, any> } {
  const tok = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || (req.headers.apikey as string);
  const claims = verify(tok);
  if (!claims) return { role: "anon", claims: { role: "anon" } };
  return { role: (claims.role as Role) ?? "anon", claims };
}

// ---------------------------------------------------------------- HTTP helpers
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, prefer, accept, range, accept-profile, content-profile, x-upsert, cache-control, x-supabase-api-version",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "content-range",
};
function send(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...CORS, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
const pgError = (res: http.ServerResponse, e: any) =>
  send(res, e.code === "42501" || /permission denied|row-level security/.test(e.message) ? 403 : 400,
    { message: e.message, code: e.code, hint: e.hint ?? null, details: e.detail ?? null });

// ---------------------------------------------------------------- Auth
async function ensureAuthTable() {
  await pool.query("create table if not exists auth.local_passwords (user_id uuid primary key references auth.users(id) on delete cascade, hash text not null)");
}
function hashPw(pw: string, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPw(pw: string, stored: string) {
  const [salt] = stored.split(":");
  return crypto.timingSafeEqual(Buffer.from(hashPw(pw, salt)), Buffer.from(stored));
}
async function session(userId: string) {
  const { rows: [u] } = await pool.query("select id, email, raw_user_meta_data, created_at from auth.users where id = $1", [userId]);
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const user = { id: u.id, aud: "authenticated", role: "authenticated", email: u.email, user_metadata: u.raw_user_meta_data ?? {}, app_metadata: { provider: "email" }, created_at: u.created_at };
  return { access_token: sign({ sub: u.id, role: "authenticated", email: u.email, aud: "authenticated", exp }), token_type: "bearer",
    expires_in: 7 * 86400, expires_at: exp, refresh_token: sign({ sub: u.id, typ: "refresh" }), user };
}
export async function createLocalUser(email: string, password: string, fullName?: string) {
  await ensureAuthTable();
  const { rows: [u] } = await pool.query("insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id", [email.toLowerCase(), JSON.stringify(fullName ? { full_name: fullName } : {})]);
  await pool.query("insert into auth.local_passwords (user_id, hash) values ($1, $2)", [u.id, hashPw(password)]);
  return u.id as string;
}

async function handleAuth(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const body = req.method === "POST" ? JSON.parse((await readBody(req)).toString() || "{}") : {};
  const p = url.pathname.replace("/auth/v1", "");
  if (p === "/signup") {
    const exists = await pool.query("select 1 from auth.users where lower(email) = lower($1)", [body.email]);
    if (exists.rowCount) return send(res, 422, { code: 422, error_code: "user_already_exists", msg: "User already registered" });
    if (!body.password || body.password.length < 8) return send(res, 422, { msg: "Password should be at least 8 characters" });
    const id = await createLocalUser(body.email, body.password, body.data?.full_name);
    return send(res, 200, await session(id));
  }
  if (p === "/token") {
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const { rows: [r] } = await pool.query("select u.id, p.hash from auth.users u join auth.local_passwords p on p.user_id = u.id where lower(u.email) = lower($1)", [body.email]);
      if (!r || !checkPw(body.password ?? "", r.hash)) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", msg: "Invalid login credentials" });
      return send(res, 200, await session(r.id));
    }
    if (grant === "refresh_token") {
      const c = verify(body.refresh_token);
      if (!c?.sub) return send(res, 400, { error: "invalid_grant", msg: "Invalid refresh token" });
      return send(res, 200, await session(c.sub));
    }
  }
  if (p === "/user") {
    const { claims } = identify(req);
    if (!claims.sub) return send(res, 401, { msg: "invalid JWT" });
    return send(res, 200, (await session(claims.sub)).user);
  }
  if (p === "/logout") return send(res, 204);
  if (p === "/otp") return send(res, 200, {});
  return send(res, 404, { msg: "not implemented in local API" });
}

// ---------------------------------------------------------------- PostgREST subset
const IDENT = /^[a-z_][a-z0-9_]*$/;
function buildWhere(url: URL, params: unknown[]) {
  const clauses: string[] = [];
  for (const [k, v] of url.searchParams) {
    if (["select", "order", "limit", "offset", "columns"].includes(k) || !IDENT.test(k)) continue;
    const m = /^(eq|neq|gt|gte|lt|lte|is|in)\.(.*)$/.exec(v);
    if (!m) continue;
    const [, op, val] = m;
    if (op === "is") clauses.push(`${k} is ${val === "null" ? "null" : val === "true" ? "true" : "false"}`);
    else if (op === "in") { params.push(val.replace(/^\(|\)$/g, "").split(",")); clauses.push(`${k}::text = any($${params.length})`); }
    else { params.push(val); clauses.push(`${k} ${{ eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op]} $${params.length}`); }
  }
  return clauses.length ? ` where ${clauses.join(" and ")}` : "";
}
async function handleRest(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const { role, claims } = identify(req);
  const rest = url.pathname.replace("/rest/v1/", "");
  try {
    if (rest.startsWith("rpc/")) {
      const args = JSON.parse((await readBody(req)).toString() || "{}");
      return send(res, 200, await callRpc(role, claims, rest.slice(4), args));
    }
    const table = rest;
    if (!IDENT.test(table)) return send(res, 404, { message: "not found" });
    const params: unknown[] = [];
    const where = buildWhere(url, params);
    const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    if (req.method === "GET" || req.method === "HEAD") {
      const sel = url.searchParams.get("select") ?? "*";
      const cols = sel === "*" ? "*" : sel.split(",").filter((c) => IDENT.test(c.trim())).join(", ");
      let order = "";
      const o = url.searchParams.get("order");
      if (o) order = " order by " + o.split(",").map((x) => { const [c, d] = x.split("."); return IDENT.test(c) ? `${c} ${d === "desc" ? "desc" : "asc"}` : ""; }).filter(Boolean).join(", ");
      const limit = url.searchParams.get("limit") ? ` limit ${Number(url.searchParams.get("limit"))}` : "";
      const rows = await asRole(role, claims, async (c) => (await c.query(`select ${cols} from public.${table}${where}${order}${limit}`, params)).rows);
      if (req.method === "HEAD") return send(res, 200, undefined, { "Content-Range": `*/${rows.length}` });
      if (single) return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows` });
      return send(res, 200, rows, { "Content-Range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` });
    }
    if (req.method === "PATCH") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const keys = Object.keys(body).filter((k) => IDENT.test(k));
      if (!keys.length) return send(res, 204);
      const base = params.length;
      const sets = keys.map((k, i) => `${k} = $${base + i + 1}`);
      const values = keys.map((k) => (Array.isArray(body[k]) && table !== "profile_contacts" ? body[k] : enc(body[k])));
      const rows = await asRole(role, claims, async (c) => (await c.query(`update public.${table} set ${sets.join(", ")}${where} returning *`, [...params, ...values])).rows);
      return (req.headers.prefer ?? "").includes("return=representation") ? send(res, 200, single ? rows[0] : rows) : send(res, 204);
    }
    if (req.method === "DELETE") {
      await asRole(role, claims, async (c) => c.query(`delete from public.${table}${where}`, params));
      return send(res, 204);
    }
    return send(res, 405, { message: "method not supported locally" });
  } catch (e) { return pgError(res, e); }
}

// ---------------------------------------------------------------- Storage subset
const signedTokens = new Map<string, { bucket: string; name: string; exp: number }>();
async function handleStorage(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const { role, claims } = identify(req);
  const p = decodeURIComponent(url.pathname.replace("/storage/v1", ""));
  const file = (bucket: string, name: string) => path.join(STORAGE_DIR, bucket, name);
  try {
    let m = /^\/object\/public\/([^/]+)\/(.+)$/.exec(p);
    if (m && req.method === "GET") {
      const [, bucket, name] = m;
      const { rows: [b] } = await pool.query("select public from storage.buckets where id = $1", [bucket]);
      if (!b?.public || !fs.existsSync(file(bucket, name))) return send(res, 404, { message: "Object not found" });
      res.writeHead(200, { ...CORS, "Content-Type": "application/octet-stream" });
      return fs.createReadStream(file(bucket, name)).pipe(res);
    }
    m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(p);
    if (m && req.method === "POST") {
      if (role !== "service_role") return send(res, 403, { message: "local API: signing restricted to service role" });
      const [, bucket, name] = m; const { expiresIn } = JSON.parse((await readBody(req)).toString());
      const token = crypto.randomBytes(16).toString("hex");
      signedTokens.set(token, { bucket, name, exp: Date.now() + expiresIn * 1000 });
      return send(res, 200, { signedURL: `/object/sign/${bucket}/${name}?token=${token}` });
    }
    if (m && req.method === "GET") {
      const t = signedTokens.get(url.searchParams.get("token") ?? "");
      if (!t || t.exp < Date.now() || t.bucket !== m[1] || t.name !== m[2]) return send(res, 400, { message: "Invalid or expired signature" });
      res.writeHead(200, { ...CORS, "Content-Type": "application/pdf" });
      return fs.createReadStream(file(t.bucket, t.name)).pipe(res);
    }
    m = /^\/object\/([^/]+)\/(.+)$/.exec(p);
    if (m && (req.method === "POST" || req.method === "PUT")) {
      const [, bucket, name] = m; const data = await readBody(req);
      const { rows: [b] } = await pool.query("select * from storage.buckets where id = $1", [bucket]);
      if (!b) return send(res, 404, { message: "Bucket not found" });
      const type = (req.headers["content-type"] ?? "").split(";")[0];
      if (b.file_size_limit && data.length > b.file_size_limit) return send(res, 413, { message: "The object exceeded the maximum allowed size" });
      if (b.allowed_mime_types && !b.allowed_mime_types.includes(type)) return send(res, 415, { message: `mime type ${type} is not supported` });
      await asRole(role, claims, (c) => c.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, name, claims.sub ?? null]));
      fs.mkdirSync(path.dirname(file(bucket, name)), { recursive: true });
      fs.writeFileSync(file(bucket, name), data);
      return send(res, 200, { Key: `${bucket}/${name}` });
    }
    m = /^\/object\/([^/]+)$/.exec(p);
    if (m && req.method === "DELETE") {
      const { prefixes } = JSON.parse((await readBody(req)).toString());
      const deleted = await asRole(role, claims, async (c) => (await c.query("delete from storage.objects where bucket_id = $1 and name = any($2) returning name", [m![1], prefixes])).rows);
      for (const d of deleted) fs.rmSync(file(m[1], d.name), { force: true });
      return send(res, 200, deleted.map((d) => ({ name: d.name })));
    }
    m = /^\/object\/list\/([^/]+)$/.exec(p);
    if (m && req.method === "POST") {
      const { prefix } = JSON.parse((await readBody(req)).toString());
      const rows = await asRole(role, claims, async (c) => (await c.query("select name from storage.objects where bucket_id = $1 and name like $2", [m![1], `${prefix}/%`])).rows);
      return send(res, 200, rows.map((r) => ({ name: r.name.slice(prefix.length + 1) })));
    }
    return send(res, 404, { message: "not implemented in local API" });
  } catch (e) { return pgError(res, e); }
}

// ---------------------------------------------------------------- Edge functions (mirrors supabase/functions/*)
async function handleFunction(req: http.IncomingMessage, res: http.ServerResponse, name: string) {
  const { role, claims } = identify(req);
  const body = JSON.parse((await readBody(req)).toString() || "{}");
  const userRpc: Rpc = (fn, args) => callRpc(role, claims, fn, args ?? {});
  const fail = (e: any) => {
    const m = String(e?.message ?? e);
    const status = /forbidden|not_authenticated/.test(m) ? 403 : /not_found/.test(m) ? 404 : /confirmation_required|already_running|invalid_transition|registration_still_open|rerun_after_reveal|event_paused|primary_round_required/.test(m) ? 409 : 400;
    send(res, status, { error: m });
  };
  try {
    if (name === "scheduler") {
      if (role !== "service_role") return send(res, 403, { error: "forbidden" });
      return send(res, 200, await runSchedulerPass(serviceRpc));
    }
    if (!claims.sub) return send(res, 401, { error: "not_authenticated" });
    if (name === "run-matching" || name === "generate-recommendations") {
      if ((await userRpc("is_event_organiser", { p_event: body.event_id })) !== true) return send(res, 403, { error: "forbidden" });
      if (name === "generate-recommendations") {
        const { rows: [ev] } = await pool.query("select post_event_reveal_at, recommendations_generated_at from events where id = $1", [body.event_id]);
        if (ev.recommendations_generated_at && new Date(ev.post_event_reveal_at) <= new Date() && body.confirm !== true) return send(res, 409, { error: "confirmation_required" });
        const r = await runRecommendationJob(serviceRpc, body.event_id);
        await serviceRpc("service_scheduler_tick", {});
        return send(res, 200, r);
      }
      const mode = body.mode === "supplemental" ? "supplemental" : "primary";
      if (body.action === "preview") return send(res, 200, await previewMatching(serviceRpc, body.event_id, mode));
      const r = await runMatchingJob(serviceRpc, { eventId: body.event_id, mode, actor: claims.sub, confirmRerun: body.confirm_rerun === true, idempotencyKey: body.idempotency_key ?? null });
      await serviceRpc("service_scheduler_tick", {});
      return send(res, 200, r);
    }
    if (name === "resume-url") {
      if ((await userRpc("can_view_resume", { p_owner: body.owner_id })) !== true) return send(res, 404, { error: "not_found" });
      const p = await serviceRpc("service_resume_path", { p_owner: body.owner_id });
      const token = crypto.randomBytes(16).toString("hex");
      signedTokens.set(token, { bucket: "resumes", name: p, exp: Date.now() + 120_000 });
      return send(res, 200, { url: `http://localhost:${PORT}/storage/v1/object/sign/resumes/${p}?token=${token}`, expires_in: 120 });
    }
    if (name === "delete-account") {
      if (body.confirm !== "DELETE") return send(res, 409, { error: "confirmation_required" });
      await serviceRpc("service_prepare_account_deletion", { p_user: claims.sub });
      await pool.query("delete from storage.objects where name like $1", [`${claims.sub}/%`]);
      await pool.query("delete from auth.users where id = $1", [claims.sub]);
      return send(res, 200, { deleted: true });
    }
    return send(res, 404, { error: "unknown function" });
  } catch (e) { return fail(e); }
}

// ---------------------------------------------------------------- server
export function start() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204);
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    try {
      if (url.pathname.startsWith("/auth/v1")) return await handleAuth(req, res, url);
      if (url.pathname.startsWith("/rest/v1/")) return await handleRest(req, res, url);
      if (url.pathname.startsWith("/storage/v1")) return await handleStorage(req, res, url);
      const fm = /^\/functions\/v1\/([a-z-]+)$/.exec(url.pathname);
      if (fm) return await handleFunction(req, res, fm[1]);
      return send(res, 404, { message: "not found" });
    } catch (e: any) { return send(res, 500, { message: e?.message ?? String(e) }); }
  });
  return new Promise<http.Server>((resolve) => server.listen(PORT, () => resolve(server)));
}

if (process.argv[1]?.endsWith("local-api.ts")) {
  await ensureAuthTable();
  await start();
  // Lifecycle tick every 30s, like pg_cron + the scheduler function.
  setInterval(() => runSchedulerPass(serviceRpc).catch((e) => console.error("tick failed", e.message)), 30_000);
  console.log(`Local Meetwise API on http://localhost:${PORT}`);
  console.log(`VITE_SUPABASE_PUBLISHABLE_KEY=${ANON_KEY}`);
}
