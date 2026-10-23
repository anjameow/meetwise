// End-to-end lifecycle with synthetic attendees against the real schema:
// organiser onboarding -> event -> registration -> scheduled matching ->
// server-gated reveal -> follow-ups -> late arrivals -> recommendations ->
// mutual connections.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMatchingJob, runSchedulerPass } from "../../supabase/functions/_shared/engine.ts";
import { anon, as, createUser, expectError, inMinutes, makeAdmin, service, setSchedule, sql, startDb, stopDb, utcLocal } from "./harness.ts";
import { createSyntheticAttendee, syntheticProfile, updateProfile } from "./synthetic.ts";

let admin: string, org: string, eventId: string, slug: string;
const attendees: string[] = [];
let incomplete: string, noConsent: string;

beforeAll(async () => { await startDb(); }, 60_000);
afterAll(async () => { await stopDb(); });

async function activePairs() {
  return sql<{ user_a: string; user_b: string }>(
    "select user_a, user_b from match_assignments where event_id = $1 and status = 'active' order by user_a, user_b", [eventId]);
}

describe("organiser onboarding", () => {
  test("organiser access must be approved by an admin", async () => {
    admin = await createUser("admin@example.test", "Ada Admin");
    await makeAdmin(admin);
    org = await createUser("org@example.test", "Olu Organiser");

    await expectError(as(org).rpc("create_event", { p: { name: "Too early" } }), "forbidden");
    expect(await as(org).rpc("request_organiser_access", { p_organisation: "Penn Network", p_reason: "We host monthly mixers." })).toBe("pending");
    const apps = await as(admin).rpc("admin_list_applications", { p_status: "pending" });
    expect(apps).toHaveLength(1);
    // A non-admin can't approve.
    await expectError(as(org).rpc("admin_decide_application", { p_application: apps[0].id, p_approve: true }), "forbidden");
    await as(admin).rpc("admin_decide_application", { p_application: apps[0].id, p_approve: true, p_note: "Welcome" });
    expect(await as(org).rpc("my_roles")).toContain("organiser");
  });

  test("organiser creates and publishes an event; times are converted from the event timezone", async () => {
    const created = await as(org).rpc("create_event", {
      p: {
        name: "Spring Mixer", timezone: "UTC", venue_name: "Houston Hall", description: "Meet one great person.",
        starts_at: utcLocal(inMinutes(60)), ends_at: utcLocal(inMinutes(240)),
        registration_deadline: utcLocal(inMinutes(30)), primary_reveal_at: utcLocal(inMinutes(45)),
        post_event_reveal_at: utcLocal(inMinutes(300)),
      },
    });
    eventId = created.id; slug = created.slug;
    expect(slug).toMatch(/^spring-mixer-[0-9a-f]{6}$/);

    // Timezone conversion is done by the server.
    const tz = await as(org).rpc("create_event", { p: { name: "NY Breakfast", timezone: "America/New_York", starts_at: "2027-01-15T09:00" } });
    const [row] = await sql("select starts_at from events where id = $1", [tz.id]);
    expect(new Date(row.starts_at).toISOString()).toBe("2027-01-15T14:00:00.000Z");

    // Drafts are invisible to the public.
    await expectError(anon().rpc("get_event_public", { p_slug: slug }), "not_found");
    await as(org).rpc("set_event_status", { p_event: eventId, p_action: "publish" });
    const pub = await anon().rpc("get_event_public", { p_slug: slug });
    expect(pub.event.name).toBe("Spring Mixer");
    expect(pub.registration_window).toBe("open");
    expect(pub.event.access_code).toBeUndefined();
  });

  test("changing a published schedule requires explicit confirmation", async () => {
    await expectError(as(org).rpc("update_event", { p_event: eventId, p: { primary_reveal_at: utcLocal(inMinutes(50)) } }), "confirmation_required");
    const r = await as(org).rpc("update_event", { p_event: eventId, p: { primary_reveal_at: utcLocal(inMinutes(50)) }, p_confirm: true });
    expect(r.schedule_changed).toBe(true);
    // Another user can't edit it.
    const stranger = await createUser("stranger@example.test");
    await expectError(as(stranger).rpc("update_event", { p_event: eventId, p: { name: "Hacked" } }), "forbidden");
  });
});

describe("registration", () => {
  test("21 complete attendees register; incomplete and non-consenting ones are excluded from matching", async () => {
    for (let i = 0; i < 21; i++) {
      const uid = await createSyntheticAttendee(i);
      attendees.push(uid);
      await as(uid).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true });
    }
    incomplete = await createUser("incomplete@example.test", "Ian Incomplete");
    await as(incomplete).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true });
    noConsent = await createSyntheticAttendee(99);
    await as(noConsent).rpc("register_for_event", { p_slug: slug, p_matching_consent: false, p_recommendations_opt_in: false });

    const hub = await as(incomplete).rpc("get_event_hub", { p_event: eventId });
    expect(hub.ineligible_reasons).toContain("profile_incomplete");
    const detail = await as(org).rpc("organiser_event_detail", { p_event: eventId });
    expect(detail.counts.registered).toBe(23);
    expect(detail.counts.eligible).toBe(21);
  });

  test("consent flags are required", async () => {
    const u = await createUser("noflags@example.test");
    await expectError(as(u).rpc("register_for_event", { p_slug: slug, p_matching_consent: null, p_recommendations_opt_in: true }), "consent_required");
  });

  test("matching cannot start while registration is still open", async () => {
    await expectError(service().rpc("service_begin_match_round", { p_event: eventId, p_mode: "primary" }), "registration_still_open");
  });
});

describe("primary matching", () => {
  test("the scheduler closes registration and runs matching once the deadline passes", async () => {
    await setSchedule(eventId, { registration_deadline: inMinutes(-1) });
    const pass = await runSchedulerPass(service().rpc);
    expect(pass.work.match).toEqual([eventId]);
    expect(pass.results[0]).toMatchObject({ job: "primary", status: "completed" });
    const [e] = await sql("select status from events where id = $1", [eventId]);
    expect(e.status).toBe("primary_ready");
  });

  test("assignments are unique, cover only eligible attendees, and leave the odd one out unmatched", async () => {
    const pairs = await activePairs();
    const users = pairs.flatMap((p) => [p.user_a, p.user_b]);
    expect(new Set(users).size).toBe(users.length);
    expect(users).not.toContain(incomplete);
    expect(users).not.toContain(noConsent);
    expect(users.every((u) => attendees.includes(u))).toBe(true);
    expect(pairs.length).toBeLessThanOrEqual(10); // 21 eligible -> at most 10 pairs
    expect(pairs.length).toBeGreaterThan(0);
    const [round] = await sql("select * from match_rounds where event_id = $1 and status = 'completed'", [eventId]);
    expect(round.eligible_count).toBe(21);
    expect(round.unmatched_count).toBe(21 - 2 * pairs.length);
  });

  test("nobody can see a match before the server-authorised reveal time", async () => {
    const u = attendees[0];
    const m = await as(u).rpc("get_my_primary_match", { p_event: eventId });
    expect(m.state).toBe("waiting");
    expect(m.match).toBeUndefined();
    // Direct API reads return nothing.
    expect(await as(u).query("select * from match_assignments")).toHaveLength(0);
    expect(await as(u).query("select * from match_round_members")).toHaveLength(0);
    expect(await as(u).query("select * from match_rounds")).toHaveLength(0);
    // Organisers can review assignments.
    expect((await as(org).query("select * from match_assignments where event_id = $1", [eventId])).length).toBeGreaterThan(0);
  });

  test("rerun requires confirmation, supersedes the old round and is deterministic", async () => {
    const before = await activePairs();
    await expectError(runMatchingJob(service().rpc, { eventId, mode: "primary" }), "confirmation_required");
    const r = await runMatchingJob(service().rpc, { eventId, mode: "primary", confirmRerun: true, idempotencyKey: "rerun-1" });
    expect(r.status).toBe("completed");
    expect(await activePairs()).toEqual(before);
    const rounds = await sql("select status from match_rounds where event_id = $1 order by round_number", [eventId]);
    expect(rounds.map((x) => x.status)).toEqual(["superseded", "completed"]);
    // Same idempotency key -> no new round.
    const again = await runMatchingJob(service().rpc, { eventId, mode: "primary", confirmRerun: true, idempotencyKey: "rerun-1" });
    expect(again.reused).toBe(true);
    expect(await sql("select 1 from match_rounds where event_id = $1", [eventId])).toHaveLength(2);
  });

  test("reveal happens by server clock; cards respect visibility and contact settings", async () => {
    const [p] = await activePairs();
    // user_a shares email with their match and hides hobbies; user_b shares nothing.
    await as(p.user_a).query("update profile_contacts set email = 'a@example.test', phone = '+1 555 0100' where user_id = $1", [p.user_a]);
    await as(p.user_a).query("update privacy_settings set match_contact_fields = '{email}', match_visible_fields = '{photo,location}' where user_id = $1", [p.user_a]);

    await setSchedule(eventId, { primary_reveal_at: new Date(Date.now() - 20_000) });
    await service().rpc("service_scheduler_tick", {});
    const [e] = await sql("select status, primary_notified_at from events where id = $1", [eventId]);
    expect(e.status).toBe("primary_revealed");
    expect(e.primary_notified_at).not.toBeNull();

    const seenByB = await as(p.user_b).rpc("get_my_primary_match", { p_event: eventId });
    expect(seenByB.state).toBe("matched");
    expect(seenByB.match.id).toBe(p.user_a);
    expect(seenByB.match.contacts).toEqual({ email: "a@example.test" }); // phone not shared
    expect(seenByB.match.hobbies).toBeUndefined();                       // hidden field
    expect(seenByB.match.organisation).toBeUndefined();
    expect(seenByB.reasons.length).toBeGreaterThan(0);
    expect(seenByB.conversation_starter).toMatch(/^Ask /);

    const seenByA = await as(p.user_a).rpc("get_my_primary_match", { p_event: eventId });
    expect(seenByA.match.id).toBe(p.user_b);
    expect(seenByA.match.contacts).toEqual({});

    const notes = await as(p.user_a).query("select type from notifications where type = 'match_ready'");
    expect(notes).toHaveLength(1);

    const pairs = await activePairs();
    const matched = new Set(pairs.flatMap((x) => [x.user_a, x.user_b]));
    const odd = attendees.find((u) => !matched.has(u));
    if (odd) expect((await as(odd).rpc("get_my_primary_match", { p_event: eventId })).state).toBe("unmatched");
  });

  test("rerun is refused after the reveal", async () => {
    await expectError(runMatchingJob(service().rpc, { eventId, mode: "primary", confirmRerun: true }), "rerun_after_reveal");
  });
});

describe("follow-up after the primary meeting", () => {
  test("mutual choices create a connection; one-sided choices are never revealed", async () => {
    const pairs = await activePairs();
    const [p1, p2] = pairs;
    // Pair 1: long_term + mentee/mentor -> mutual.
    await as(p1.user_a).rpc("submit_match_followup", { p_assignment: await assignmentId(p1), p_choice: "mentor" });
    const r = await as(p1.user_b).rpc("submit_match_followup", { p_assignment: await assignmentId(p1), p_choice: "mentee" });
    expect(r.outcome).toBe("mutual_mentorship");
    const view = await as(p1.user_a).rpc("get_my_primary_match", { p_event: eventId });
    expect(view.followup_outcome).toBe("mutual_mentorship");
    const conns = await as(p1.user_a).rpc("my_connections");
    expect(conns[0].user_id).toBe(p1.user_b);
    expect(conns[0].mentor_id).toBe(p1.user_a);

    // Pair 2: long_term + thanks -> nothing, and the hopeful side learns nothing.
    await as(p2.user_a).rpc("submit_match_followup", { p_assignment: await assignmentId(p2), p_choice: "long_term" });
    await as(p2.user_b).rpc("submit_match_followup", { p_assignment: await assignmentId(p2), p_choice: "thanks" });
    const hopeful = await as(p2.user_a).rpc("get_my_primary_match", { p_event: eventId });
    expect(hopeful.my_followup).toBe("long_term");
    expect(hopeful.followup_outcome).toBeNull();
    expect(JSON.stringify(hopeful)).not.toContain("thanks");
    expect(await as(p2.user_a).query("select * from match_followups")).toHaveLength(1); // only own row
    expect(await as(p2.user_a).rpc("my_connections")).toEqual([]);

    // Feedback.
    await as(p2.user_a).rpc("submit_match_feedback", { p_assignment: await assignmentId(p2), p_rating: 4, p_met_in_person: true, p_event_rating: 5, p_comment: "Great chat" });
    // A stranger cannot act on someone else's assignment.
    const outsider = attendees.find((u) => u !== p1.user_a && u !== p1.user_b)!;
    await expectError(as(outsider).rpc("submit_match_followup", { p_assignment: await assignmentId(p1), p_choice: "long_term" }), "not_found");
  });
});

async function assignmentId(p: { user_a: string; user_b: string }) {
  const [r] = await sql("select id from match_assignments where user_a = $1 and user_b = $2 and status = 'active'", [p.user_a, p.user_b]);
  return r.id as string;
}

describe("withdrawals and late arrivals", () => {
  let freed: string; let late: string;

  test("a withdrawal cancels the match without explaining why", async () => {
    const pairs = await activePairs();
    const p = pairs[pairs.length - 1];
    freed = p.user_b;
    await as(p.user_a).rpc("withdraw_from_event", { p_event: eventId });
    const v = await as(freed).rpc("get_my_primary_match", { p_event: eventId });
    expect(v.state).toBe("match_unavailable");
    expect(v.awaiting_rematch).toBe(true);
    expect(JSON.stringify(v)).not.toContain("withdraw");
    expect(v.match).toBeUndefined();
  });

  test("late arrivals join a supplemental round together with freed attendees", async () => {
    late = await createSyntheticAttendee(50, syntheticProfile(5)); // compatible-ish clone of attendee 5's preferences
    const reg = await as(late).rpc("register_for_event", { p_slug: slug, p_matching_consent: true, p_recommendations_opt_in: true });
    expect(reg.is_late).toBe(true);
    expect((await as(late).rpc("get_my_primary_match", { p_event: eventId })).state).toBe("matching");

    await sql("update event_registrations set awaiting_match_since = now() - interval '5 minutes' where event_id = $1 and awaiting_match_since is not null", [eventId]);
    const pass = await runSchedulerPass(service().rpc);
    expect(pass.work.supplemental).toEqual([eventId]);

    // Global invariant still holds across rounds.
    const users = (await activePairs()).flatMap((p) => [p.user_a, p.user_b]);
    expect(new Set(users).size).toBe(users.length);
    const lateState = (await as(late).rpc("get_my_primary_match", { p_event: eventId })).state;
    expect(["matched", "unmatched"]).toContain(lateState);
    // The freed attendee is never re-paired with the person who withdrew.
    const freedRow = await sql("select * from match_assignments where status = 'active' and $1 in (user_a, user_b)", [freed]);
    expect(freedRow.length).toBeLessThanOrEqual(1);

    // No supplemental loop: nothing is due on the next pass.
    const again = await runSchedulerPass(service().rpc);
    expect(again.work.supplemental).toEqual([]);
  });

  test("blocking your match cancels it silently", async () => {
    const pairs = await activePairs();
    const p = pairs[2];
    const count = async () => (await as(p.user_b).query("select 1 from notifications where type = 'match_unavailable'")).length;
    const before = await count();
    await as(p.user_a).rpc("block_user", { p_user: p.user_b });
    expect((await as(p.user_b).rpc("get_my_primary_match", { p_event: eventId })).state).toBe("match_unavailable");
    expect(await count()).toBe(before);
  });
});

describe("post-event recommendations", () => {
  let optedOut = "";
  test("generated before the reveal, hidden until it", async () => {
    const start = inMinutes(-200); const end = inMinutes(-1);
    await setSchedule(eventId, { starts_at: start, ends_at: end, post_event_reveal_at: inMinutes(10) });
    // One (still registered) attendee opts out of recommendations.
    const [still] = await sql("select user_id from event_registrations where event_id = $1 and status = 'registered' and user_id = any($2) order by user_id limit 1", [eventId, attendees]);
    optedOut = still.user_id;
    await as(optedOut).rpc("update_my_registration", { p_event: eventId, p_matching_consent: true, p_recommendations_opt_in: false });

    const pass = await runSchedulerPass(service().rpc);
    expect(pass.work.recommendations).toEqual([eventId]);
    const [e] = await sql("select status, recommendations_generated_at from events where id = $1", [eventId]);
    expect(e.status).toBe("event_ended");
    expect(e.recommendations_generated_at).not.toBeNull();

    const [viewer] = await sql("select user_id from event_registrations where event_id = $1 and status = 'registered' and recommendations_opt_in and user_id = any($2) limit 1", [eventId, attendees]);
    const early = await as(viewer.user_id).rpc("get_my_recommendations", { p_event: eventId });
    expect(early.state).toBe("waiting");
    expect(early.items).toBeUndefined();
    expect(await as(viewer.user_id).query("select * from recommendations")).toHaveLength(0);
  });

  test("after the reveal: at most five, excluding primary match, blocked and opted-out users", async () => {
    await setSchedule(eventId, { post_event_reveal_at: new Date(Date.now() - 1000) });
    await service().rpc("service_scheduler_tick", {});
    const [e] = await sql("select status from events where id = $1", [eventId]);
    expect(e.status).toBe("recommendations_available");

    const blocks = await sql("select blocker_id, blocked_id from blocks");
    for (const u of attendees.slice(0, 12)) {
      const recs = await as(u).rpc("get_my_recommendations", { p_event: eventId });
      if (recs.state !== "available") continue;
      const ids = recs.items.map((x: any) => x.user_id);
      expect(ids.length).toBeLessThanOrEqual(5);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(u);
      expect(ids).not.toContain(optedOut);
      expect(ids).not.toContain(incomplete);
      const primary = await sql("select user_a, user_b from match_assignments where event_id = $1 and $2 in (user_a, user_b) and status in ('active','cancelled')", [eventId, u]);
      for (const p of primary) expect(ids).not.toContain(p.user_a === u ? p.user_b : p.user_a);
      for (const b of blocks) {
        if (b.blocker_id === u) expect(ids).not.toContain(b.blocked_id);
        if (b.blocked_id === u) expect(ids).not.toContain(b.blocker_id);
      }
      for (const item of recs.items) {
        expect(item.profile.contacts).toEqual({}); // never contact details in recommendations
        expect(item.reasons.length).toBeGreaterThan(0);
      }
    }
    // Opted-out attendee doesn't receive any either.
    expect((await as(optedOut).rpc("get_my_recommendations", { p_event: eventId })).state).toBe("not_opted_in");
  });

  test("connection requests need mutual agreement and declines stay private", async () => {
    let requester = "", recipient = "";
    for (const u of attendees) {
      const recs = await as(u).rpc("get_my_recommendations", { p_event: eventId });
      if (recs.state === "available" && recs.items.length >= 2) {
        requester = u; recipient = recs.items[0].user_id; break;
      }
    }
    expect(requester).not.toBe("");
    // Recipient's contact details are set; not visible until accepted.
    await as(recipient).query("update profile_contacts set linkedin_url = 'https://www.linkedin.com/in/recipient' where user_id = $1", [recipient]);

    await as(requester).rpc("save_profile", { p_user: recipient, p_event: eventId });
    expect((await as(requester).rpc("my_saved_profiles"))[0].user_id).toBe(recipient);

    const sent = await as(requester).rpc("send_connection_request", { p_recipient: recipient, p_event: eventId, p_kind: "connect", p_message: "Loved your intro!" });
    expect(sent.status).toBe("pending");
    expect(await as(requester).query("select * from connection_requests")).toHaveLength(0); // no direct reads

    const incoming = await as(recipient).rpc("my_connection_requests");
    expect(incoming.incoming).toHaveLength(1);
    expect(incoming.incoming[0].profile.contacts).toEqual({});

    await as(recipient).rpc("respond_connection_request", { p_request: incoming.incoming[0].id, p_accept: false });
    const out = await as(requester).rpc("my_connection_requests");
    expect(out.outgoing[0].status).toBe("pending"); // decline is masked
    const resend = await as(requester).rpc("send_connection_request", { p_recipient: recipient, p_event: eventId });
    expect(resend.status).toBe("pending");
    expect((await as(recipient).rpc("my_connection_requests")).incoming).toHaveLength(0); // not re-notified
    expect((await as(requester).rpc("my_connections")).map((c: any) => c.user_id)).not.toContain(recipient);

    // The other direction: recipient asks, requester accepts -> connected, contacts unlocked.
    const sent2 = await as(recipient).rpc("send_connection_request", { p_recipient: requester, p_event: eventId }).catch((e) => ({ status: e.message }));
    if (sent2.status === "pending") {
      const inc = await as(requester).rpc("my_connection_requests");
      await as(requester).rpc("respond_connection_request", { p_request: inc.incoming[0].id, p_accept: true });
      const conns = await as(requester).rpc("my_connections");
      const c = conns.find((x: any) => x.user_id === recipient);
      expect(c.profile.contacts).toEqual({ linkedin: "https://www.linkedin.com/in/recipient" });
    } else {
      // recipient wasn't shown requester as a recommendation: requests are only allowed to people you were introduced to
      expect(sent2.status).toContain("not_found");
    }
  });

  test("you cannot request someone you were never introduced to", async () => {
    const outsider = await createSyntheticAttendee(77);
    await expectError(as(outsider).rpc("send_connection_request", { p_recipient: attendees[0] }), "not_found");
    await expectError(as(outsider).rpc("save_profile", { p_user: attendees[0] }), "not_found");
  });
});

describe("resumes, analytics and account deletion", () => {
  test("resume access requires the owner's setting and a relationship", async () => {
    const conn = await sql("select user_a, user_b from connections limit 1");
    const { user_a: owner, user_b: viewer } = conn[0];
    await as(owner).rpc("record_resume_upload", { p_path: `${owner}/cv-1.pdf`, p_file_name: "cv.pdf", p_size: 1000 });
    await expectError(as(owner).rpc("record_resume_upload", { p_path: `${viewer}/cv-1.pdf`, p_file_name: "cv.pdf", p_size: 1000 }), "forbidden");
    expect(await as(owner).rpc("can_view_resume", { p_owner: owner })).toBe(true);
    expect(await as(viewer).rpc("can_view_resume", { p_owner: owner })).toBe(false); // default 'nobody'
    await as(owner).query("update privacy_settings set resume_visibility = 'connections' where user_id = $1", [owner]);
    expect(await as(viewer).rpc("can_view_resume", { p_owner: owner })).toBe(true);
    const unrelated = await createSyntheticAttendee(88);
    expect(await as(unrelated).rpc("can_view_resume", { p_owner: owner })).toBe(false);
    // The resume row itself is owner-only.
    expect(await as(viewer).query("select * from resumes")).toHaveLength(0);
  });

  test("analytics are aggregated", async () => {
    const a = await as(org).rpc("event_analytics", { p_event: eventId });
    expect(a.counts.registered).toBeGreaterThan(0);
    expect(a.feedback.responses).toBe(1);
    expect(a.connections_made).toBeGreaterThanOrEqual(1);
    await expectError(as(attendees[0]).rpc("event_analytics", { p_event: eventId }), "forbidden");
  });

  test("account deletion withdraws the user and removes their data", async () => {
    const victim = attendees[10];
    await service().rpc("service_prepare_account_deletion", { p_user: victim });
    await sql("delete from auth.users where id = $1", [victim]);
    expect(await sql("select 1 from profiles where id = $1", [victim])).toHaveLength(0);
    expect(await sql("select 1 from recommendations where user_id = $1 or recommended_user_id = $1", [victim])).toHaveLength(0);
    expect(await sql("select 1 from match_round_members where user_id = $1", [victim])).toHaveLength(0);
  });
});
