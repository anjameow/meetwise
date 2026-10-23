// Integration-test harness. Runs the real migrations on a throwaway local
// PostgreSQL (see scripts/local-db.sh) and executes every call exactly the way
// PostgREST does for an API request: inside a transaction, as role
// anon/authenticated/service_role, with request.jwt.claims set.
import { execSync } from "node:child_process";
import pg from "pg";
import type { Rpc } from "../../supabase/functions/_shared/engine.ts";

export let pool: pg.Pool;

export async function startDb() {
  execSync("bash scripts/local-db.sh", { stdio: "pipe" });
  pool = new pg.Pool({ host: "/tmp", port: 54329, user: "postgres", database: "meetwise", max: 8 });
  return pool;
}

export async function stopDb() {
  await pool?.end();
}

/** Superuser SQL — used only for test setup and simulating time passing. */
export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

type Role = "anon" | "authenticated" | "service_role";

function encode(v: unknown) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

async function asRole<T>(role: Role, uid: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(uid ? { sub: uid, role } : { role }),
    ]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export interface Client {
  rpc: Rpc;
  query: <T = any>(text: string, params?: unknown[]) => Promise<T[]>;
}

export function client(role: Role, uid: string | null = null): Client {
  return {
    rpc: async (name, args = {}) => {
      const out = await asRole(role, uid, async (c) => {
        const keys = Object.keys(args);
        const call = `select to_jsonb(public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})) as r`;
        const res = await c.query(call, keys.map((k) => encode(args[k])));
        return res.rows[0]?.r ?? null;
      });
      // Like the frontend: an {error} result (committed, e.g. so rate limits
      // count rejected attempts) is surfaced as an error.
      if (out && typeof out === "object" && !Array.isArray(out) && typeof out.error === "string") throw new Error(out.error);
      return out;
    },
    query: (text, params = []) => asRole(role, uid, async (c) => (await c.query(text, params)).rows),
  };
}

export const anon = () => client("anon");
export const service = () => client("service_role");
export const as = (uid: string) => client("authenticated", uid);

export async function createUser(email: string, fullName?: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify(fullName ? { full_name: fullName } : {})],
  );
  return row.id;
}

export async function makeAdmin(uid: string) {
  await sql("insert into public.user_roles (user_id, role) values ($1, 'admin') on conflict do nothing", [uid]);
}

/** Format a Date as a wall-clock string in UTC, for events whose timezone is UTC. */
export function utcLocal(d: Date) {
  return d.toISOString().slice(0, 16);
}

export function inMinutes(m: number) {
  return new Date(Date.now() + m * 60_000);
}

export async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    if (!String(e.message).includes(code)) throw new Error(`expected error "${code}", got "${e.message}"`);
    return e;
  }
  throw new Error(`expected error "${code}" but call succeeded`);
}

/** Shift an event's schedule into the past/future to simulate time passing. */
export async function setSchedule(eventId: string, s: Partial<Record<
  "registration_deadline" | "primary_reveal_at" | "starts_at" | "ends_at" | "post_event_reveal_at", Date>>) {
  const sets = Object.entries(s).map(([k], i) => `${k} = $${i + 2}`);
  await sql(`update public.events set ${sets.join(", ")} where id = $1`, [eventId, ...Object.values(s)]);
}
