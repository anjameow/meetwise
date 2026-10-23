// LOCAL DEVELOPMENT ONLY: seeds the local database (scripts/local-db.sh) with
// an admin, an organiser, a published event and synthetic attendees so the UI
// can be explored end-to-end. Never run against production.
import pg from "pg";
import { createLocalUser } from "./local-api.ts";
import { syntheticProfile } from "../tests/db/synthetic.ts";

const db = new pg.Pool({ host: "/tmp", port: Number(process.env.MEETWISE_PGPORT ?? 54329), user: "postgres", database: "meetwise" });
const PASSWORD = "meetwise-demo-123";

async function asUser<T>(uid: string, fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } finally { c.release(); }
}

export async function seed(attendees = 11) {
  await db.query("create table if not exists auth.local_passwords (user_id uuid primary key references auth.users(id) on delete cascade, hash text not null)");
  const admin = await createLocalUser("admin@meetwise.test", PASSWORD, "Ada Admin");
  await db.query("insert into user_roles (user_id, role) values ($1, 'admin'), ($1, 'organiser')", [admin]);
  const org = await createLocalUser("organiser@meetwise.test", PASSWORD, "Olu Organiser");
  await db.query("insert into user_roles (user_id, role) values ($1, 'organiser')", [org]);

  const fmt = (m: number) => new Date(Date.now() + m * 60_000).toISOString().slice(0, 16);
  const ev = await asUser(org, async (c) => (await c.query("select public.create_event($1) as r", [JSON.stringify({
    name: "Penn Founders & Funders Mixer", tagline: "One great introduction, guaranteed.", timezone: "UTC",
    description: "An evening for builders, operators, investors and the curious. Meetwise will introduce you to the one person you should talk to.",
    venue_name: "Houston Hall", venue_address: "3417 Spruce St, Philadelphia",
    registration_deadline: fmt(30), starts_at: fmt(40), primary_reveal_at: fmt(60), ends_at: fmt(180), post_event_reveal_at: fmt(240),
  })])).rows[0].r);
  await asUser(org, (c) => c.query("select public.set_event_status($1, 'publish', false)", [ev.id]));

  const ids: string[] = [];
  for (let i = 0; i < attendees; i++) {
    const p = syntheticProfile(i, 7);
    const uid = await createLocalUser(`attendee${i}@meetwise.test`, PASSWORD, p.full_name);
    const keys = Object.keys(p);
    await asUser(uid, async (c) => {
      await c.query(`update profiles set ${keys.map((k, j) => `${k} = $${j + 2}`).join(", ")} where id = $1`, [uid, ...keys.map((k) => (p as any)[k])]);
      await c.query("update profile_contacts set linkedin_url = $2, email = $3 where user_id = $1", [uid, `https://www.linkedin.com/in/attendee${i}`, `attendee${i}@example.com`]);
      await c.query("update privacy_settings set match_contact_fields = '{linkedin}' where user_id = $1", [uid]);
      await c.query("select public.register_for_event($1, true, true)", [ev.slug]);
    });
    ids.push(uid);
  }
  return { admin, org, event: ev as { id: string; slug: string }, attendees: ids, password: PASSWORD };
}

if (process.argv[1]?.endsWith("seed-local.ts")) {
  const r = await seed();
  console.log(JSON.stringify({ ...r, logins: ["admin@meetwise.test", "organiser@meetwise.test", "attendee0@meetwise.test"], url: `/e/${r.event.slug}` }, null, 2));
  await db.end();
  process.exit(0);
}
