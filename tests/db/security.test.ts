// Access-control tests issued exactly like direct REST/RPC API requests
// (role + JWT claims), independent of the UI.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { anon, as, createUser, expectError, inMinutes, service, sql, startDb, stopDb, utcLocal } from "./harness.ts";
import { createSyntheticAttendee } from "./synthetic.ts";

let alice: string, bob: string, org: string, eventId: string, slug: string;

beforeAll(async () => {
  await startDb();
  alice = await createSyntheticAttendee(1);
  bob = await createSyntheticAttendee(2);
  org = await createUser("org@example.test", "Org");
  await sql("insert into user_roles (user_id, role) values ($1, 'organiser')", [org]);
  const ev = await as(org).rpc("create_event", {
    p: {
      name: "Security Night", timezone: "UTC", access_code: "SECRET-1",
      starts_at: utcLocal(inMinutes(60)), ends_at: utcLocal(inMinutes(120)),
      registration_deadline: utcLocal(inMinutes(30)), primary_reveal_at: utcLocal(inMinutes(40)),
      post_event_reveal_at: utcLocal(inMinutes(180)),
    },
  });
  eventId = ev.id; slug = ev.slug;
  await as(org).rpc("set_event_status", { p_event: eventId, p_action: "publish" });
}, 60_000);
afterAll(stopDb);

const TABLES = ["profiles", "profile_contacts", "privacy_settings", "resumes", "events", "event_organisers",
  "event_registrations", "match_rounds", "match_assignments", "match_round_members", "match_followups",
  "match_feedback", "recommendations", "saved_profiles", "connection_requests", "connections", "blocks",
  "reports", "notifications", "audit_logs", "rate_limit_events", "user_roles", "organiser_applications"];

describe("row level security", () => {
  test("RLS is enabled on every public table", async () => {
    const rows = await sql("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity");
    expect(rows).toEqual([]);
  });

  test("anonymous requests cannot read any table", async () => {
    for (const t of TABLES) {
      await expectError(anon().query(`select * from public.${t}`), "permission denied");
    }
  });

  test("anonymous requests can only call get_event_public", async () => {
    const pub = await anon().rpc("get_event_public", { p_slug: slug });
    expect(pub.event.requires_access_code).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("SECRET-1");
    expect(JSON.stringify(pub)).not.toContain("matching_weights");
    await expectError(anon().rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true }), "permission denied");
    await expectError(anon().rpc("my_events"), "permission denied");
  });

  test("users only see their own profile, contacts and privacy rows", async () => {
    for (const t of ["profiles", "profile_contacts", "privacy_settings"]) {
      const rows = await as(alice).query(`select * from public.${t}`);
      expect(rows).toHaveLength(1);
      expect(rows[0].id ?? rows[0].user_id).toBe(alice);
    }
    expect(await as(alice).query("select * from profiles where id = $1", [bob])).toHaveLength(0);
  });

  test("users cannot modify other users' rows", async () => {
    const r = await as(alice).query("update profiles set full_name = 'pwned' where id = $1 returning id", [bob]);
    expect(r).toHaveLength(0);
    const [b] = await sql("select full_name from profiles where id = $1", [bob]);
    expect(b.full_name).not.toBe("pwned");
  });

  test("protected profile columns cannot be written by their owner", async () => {
    await expectError(as(alice).query("update profiles set suspended_at = null where id = $1", [alice]), "permission denied");
    await expectError(as(alice).query("update profiles set profile_completed_at = now() where id = $1", [alice]), "permission denied");
    await expectError(as(alice).query("update profiles set id = gen_random_uuid() where id = $1", [alice]), "permission denied");
  });

  test("server decides profile completeness", async () => {
    const [before] = await sql("select profile_completed_at from profiles where id = $1", [alice]);
    expect(before.profile_completed_at).not.toBeNull();
    await as(alice).query("update profiles set quirky_intro = null where id = $1", [alice]);
    const [after] = await sql("select profile_completed_at from profiles where id = $1", [alice]);
    expect(after.profile_completed_at).toBeNull();
    await as(alice).query("update profiles set quirky_intro = 'I collect vintage maps of places I have never been' where id = $1", [alice]);
  });

  test("input validation is enforced by the database", async () => {
    await expectError(as(alice).query("update profiles set quirky_intro = $2 where id = $1", [alice, "x".repeat(161)]), "check");
    await expectError(as(alice).query("update profiles set career_goals = '{take_over_world}' where id = $1", [alice]), "check");
    await expectError(as(alice).query("update profile_contacts set linkedin_url = 'javascript:alert(1)' where user_id = $1", [alice]), "check");
    await expectError(as(alice).query("update privacy_settings set match_contact_fields = '{ssn}' where user_id = $1", [alice]), "check");
  });

  test("no direct inserts into privileged tables", async () => {
    const attempts = [
      ["user_roles", "insert into user_roles (user_id, role) values ($1, 'admin')"],
      ["event_registrations", `insert into event_registrations (event_id, user_id, matching_consent, consent_version) values ('${eventId}', $1, true, 'x')`],
      ["match_assignments", `insert into match_assignments (round_id, event_id, user_a, user_b, score) values (gen_random_uuid(), '${eventId}', $1, $1, 1)`],
      ["recommendations", `insert into recommendations (event_id, user_id, recommended_user_id, rank, score) values ('${eventId}', $1, $1, 1, 1)`],
      ["connections", "insert into connections (user_a, user_b, kind, source) values ($1, $1, 'connect', 'request')"],
      ["notifications", "insert into notifications (user_id, type, title) values ($1, 'x', 'x')"],
      ["resumes", "insert into resumes (user_id, storage_path, file_name, size_bytes, mime_type) values ($1, 'x', 'x', 1, 'application/pdf')"],
    ];
    for (const [, q] of attempts) await expectError(as(alice).query(q, [alice]), "permission denied");
  });

  test("attendees cannot read events directly or see other organisers' events", async () => {
    expect(await as(alice).query("select * from events")).toHaveLength(0);
    expect(await as(org).query("select * from events")).toHaveLength(1);
    const other = await createUser("org2@example.test");
    await sql("insert into user_roles (user_id, role) values ($1, 'organiser')", [other]);
    expect(await as(other).query("select * from events")).toHaveLength(0);
    await expectError(as(other).rpc("organiser_event_attendees", { p_event: eventId }), "forbidden");
    await expectError(as(other).rpc("set_event_status", { p_event: eventId, p_action: "pause", p_confirm: true }), "forbidden");
  });

  test("service-only functions are not callable by users", async () => {
    for (const [fn, args] of [
      ["service_begin_match_round", { p_event: eventId, p_mode: "primary" }],
      ["service_commit_match_round", { p_round: eventId, p_pairs: [], p_algorithm: "x" }],
      ["service_round_snapshot", { p_round: eventId }],
      ["service_matching_preview", { p_event: eventId }],
      ["service_commit_recommendations", { p_event: eventId, p_recs: [] }],
      ["service_scheduler_tick", {}],
      ["service_prepare_account_deletion", { p_user: bob }],
    ] as const) {
      await expectError(as(org).rpc(fn, args as any), "permission denied");
    }
  });

  test("admin functions require the admin role", async () => {
    await expectError(as(alice).rpc("admin_overview"), "forbidden");
    await expectError(as(org).rpc("admin_set_role", { p_user: org, p_role: "admin", p_grant: true }), "forbidden");
  });
});

describe("registration rules", () => {
  test("access code is enforced", async () => {
    await expectError(as(alice).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true }), "invalid_access_code");
    const r = await as(alice).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true, p_access_code: "SECRET-1" });
    expect(r.status).toBe("registered");
  });

  test("rate limiting kicks in", async () => {
    const u = await createSyntheticAttendee(3);
    let limited = false;
    for (let i = 0; i < 12; i++) {
      try {
        await as(u).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true, p_access_code: "WRONG" });
      } catch (e: any) {
        if (String(e.message).includes("rate_limited")) { limited = true; break; }
      }
    }
    expect(limited).toBe(true);
  });

  test("capacity and email-domain rules", async () => {
    await as(org).rpc("update_event", { p_event: eventId, p: { capacity: 2, allowed_email_domains: ["example.test"] } });
    const c = await createSyntheticAttendee(4);
    await as(c).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true, p_access_code: "SECRET-1" });
    const d = await createSyntheticAttendee(5);
    await expectError(as(d).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true, p_access_code: "SECRET-1" }), "event_full");
    await as(org).rpc("update_event", { p_event: eventId, p: { capacity: null, allowed_email_domains: ["upenn.edu"] } });
    await expectError(as(d).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true, p_access_code: "SECRET-1" }), "email_domain_not_allowed");
    await as(org).rpc("update_event", { p_event: eventId, p: { allowed_email_domains: [] } });
  });

  test("organisers see attendee basics but never contact details", async () => {
    await as(alice).query("update profile_contacts set phone = '+44 7700 900000' where user_id = $1", [alice]);
    const list = await as(org).rpc("organiser_event_attendees", { p_event: eventId });
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain("7700");
    expect(await as(org).query("select * from profile_contacts")).toHaveLength(1); // only their own
  });
});

describe("matching job safety", () => {
  test("concurrent launches share one running round; invalid commits are rejected atomically", async () => {
    await as(bob).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true, p_access_code: "SECRET-1" });
    await sql("update events set registration_deadline = now() - interval '1 minute' where id = $1", [eventId]);
    const first = await service().rpc("service_begin_match_round", { p_event: eventId, p_mode: "primary" });
    const second = await service().rpc("service_begin_match_round", { p_event: eventId, p_mode: "primary" });
    expect(second.already_running).toBe(true);
    expect(second.round_id).toBe(first.round_id);

    // Duplicate user in two pairs -> whole commit rolls back.
    const [x] = await sql("select user_id from match_round_members where round_id = $1 limit 1", [first.round_id]);
    const members = (await sql("select user_id from match_round_members where round_id = $1", [first.round_id])).map((r) => r.user_id);
    const others = members.filter((m) => m !== x.user_id);
    await expectError(service().rpc("service_commit_match_round", {
      p_round: first.round_id, p_algorithm: "test",
      p_pairs: [{ a: x.user_id, b: others[0], score: 50 }, { a: x.user_id, b: others[1], score: 40 }],
    }), "duplicate_user");
    expect(await sql("select 1 from match_assignments where round_id = $1", [first.round_id])).toHaveLength(0);

    // A user outside the frozen pool can't be injected.
    const outsider = await createSyntheticAttendee(6);
    await expectError(service().rpc("service_commit_match_round", {
      p_round: first.round_id, p_algorithm: "test", p_pairs: [{ a: x.user_id, b: outsider, score: 50 }],
    }), "not_in_pool");

    // Fail, then retry cleanly.
    await service().rpc("service_fail_match_round", { p_round: first.round_id, p_error: "simulated crash" });
    const [ev] = await sql("select status, auto_match_failures from events where id = $1", [eventId]);
    expect(ev.status).toBe("registration_closed");
    expect(ev.auto_match_failures).toBe(1);
    const retry = await service().rpc("service_begin_match_round", { p_event: eventId, p_mode: "primary" });
    expect(retry.round_id).not.toBe(first.round_id);
    const ok = await service().rpc("service_commit_match_round", { p_round: retry.round_id, p_algorithm: "test", p_pairs: [{ a: alice, b: bob, score: 61.5 }] });
    expect(ok.matched_pairs).toBe(1);
    // Committing the same round twice is a no-op.
    const dup = await service().rpc("service_commit_match_round", { p_round: retry.round_id, p_algorithm: "test", p_pairs: [] });
    expect(dup.already_completed).toBe(true);
    expect(await sql("select 1 from match_assignments where round_id = $1", [retry.round_id])).toHaveLength(1);
  });

  test("the database refuses a second active match for the same person", async () => {
    // Even a superuser writing a second active membership is rejected.
    const [r2] = await sql("insert into match_rounds (event_id, round_number, mode, status, weights, rules) values ($1, 99, 'supplemental', 'completed', '{}', '{}') returning id", [eventId]);
    await expectError(sql("insert into match_round_members (round_id, event_id, user_id, assignment_active) values ($1, $2, $3, true)", [r2.id, eventId, alice]), "duplicate key");
    await sql("delete from match_rounds where id = $1", [r2.id]);
  });

  test("matches stay hidden before the reveal even for the matched pair", async () => {
    const m = await as(alice).rpc("get_my_primary_match", { p_event: eventId });
    expect(m.state).toBe("waiting");
    await expectError(as(alice).rpc("submit_match_followup", {
      p_assignment: (await sql("select id from match_assignments where event_id = $1 limit 1", [eventId]))[0].id, p_choice: "long_term",
    }), "not_found");
  });

  test("pausing an event holds the reveal", async () => {
    await sql("update events set primary_reveal_at = now() - interval '1 second' where id = $1", [eventId]);
    expect((await as(alice).rpc("get_my_primary_match", { p_event: eventId })).state).toBe("matched");
    await as(org).rpc("set_event_status", { p_event: eventId, p_action: "pause", p_confirm: true });
    expect((await as(alice).rpc("get_my_primary_match", { p_event: eventId })).state).toBe("waiting");
    await as(org).rpc("set_event_status", { p_event: eventId, p_action: "resume", p_confirm: true });
  });
});

describe("storage policies", () => {
  test("users can only write to their own resume folder", async () => {
    await as(alice).query("insert into storage.objects (bucket_id, name, owner) values ('resumes', $1, $2)", [`${alice}/cv.pdf`, alice]);
    await expectError(as(alice).query("insert into storage.objects (bucket_id, name, owner) values ('resumes', $1, $2)", [`${bob}/cv.pdf`, alice]), "row-level security");
    expect(await as(bob).query("select * from storage.objects where bucket_id = 'resumes'")).toHaveLength(0);
    expect(await as(alice).query("select * from storage.objects where bucket_id = 'resumes'")).toHaveLength(1);
  });
});
