# Meetwise

Professional matchmaking for in-person events. Attendees scan a QR code, build a short profile, get **one** highly relevant introduction at a server-controlled reveal time, then discover **up to five** more people after the event. Connections are always mutual.

Stack (Lovable-compatible): Vite + React 18 + TypeScript + Tailwind, TanStack Query, React Router, Supabase (Postgres, Auth, Storage, Edge Functions, RLS, pg_cron).

## What's built

| Area | Where |
|---|---|
| Schema, constraints, indexes | `supabase/migrations/…01_core_schema.sql` |
| RLS, column grants, private storage | `…02_security.sql` |
| Attendee RPCs (registration, reveal-gated match, blind follow-ups, recommendations, mutual requests, block/report) | `…03_attendee_rpcs.sql` |
| Organiser RPCs + idempotent matching-job interface | `…04_organiser_matching.sql` |
| Admin, lifecycle scheduler tick, retention | `…05_admin_scheduler.sql` |
| Function grant whitelist, pg_cron job | `…06_grants_and_cron.sql` |
| Matching engine: scoring, truthful reasons, blossom max-weight matching | `supabase/functions/_shared/` |
| Edge functions | `run-matching`, `generate-recommendations`, `scheduler`, `resume-url`, `delete-account` |
| Frontend | `src/` (attendee flow, organiser dashboard, admin console) |

### Key guarantees (enforced in the database, not the UI)
- **Reveal gating:** `get_my_primary_match` / `get_my_recommendations` check `now()` against the event's reveal times (and pause state). Attendees have no direct read access to assignments or recommendations tables.
- **One match per person per event:** partial unique index on `match_round_members(event_id, user_id) where assignment_active`, plus validation in `service_commit_match_round`.
- **Idempotent matching:** the pool is frozen when a round begins; commit is a single transaction; one running round per event (unique index); idempotency keys; stale jobs auto-fail and can be retried; reruns need explicit confirmation and are refused after the reveal. Late arrivals get supplemental rounds that never touch existing matches.
- **Global matching:** maximum-weight, maximum-cardinality matching (Edmonds' blossom), members sorted by id, so submission order never matters. Pairs below `min_score` are not created: no made-up matches.
- **Privacy:** contact details live in an owner-only table and are only returned through visibility-filtered profile cards. Follow-up choices are blind (revealed only when mutual). Declined connection requests look "pending" to the requester. Résumés are in a private bucket, served via 2-minute signed URLs after `can_view_resume()` passes. Organisers never see contacts, résumés or private decisions.
- **Abuse controls:** rate limits (registration, requests, reports, uploads), CHECK constraints on every field, structured vocabularies, no sensitive characteristics collected.

Matching weights (30/25/15/15/10/5) are editable per event (and platform defaults in admin) and are labelled in the UI as starting hypotheses.

## Setup on Supabase / Lovable

**Non-technical?** Follow [SETUP_GUIDE.md](SETUP_GUIDE.md) instead: it's browser-only, with copy-paste database files and single-file edge functions from `supabase/dashboard/` (rebuild them with `bash scripts/build-dashboard-functions.sh` after changing a function).

1. Create a Supabase project (or connect Lovable Cloud) and apply `supabase/migrations/*.sql` in order (`supabase db push`).
2. Deploy edge functions: `supabase functions deploy run-matching generate-recommendations scheduler resume-url delete-account`.
3. Frontend env (`.env`, see `.env.example`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (anon key only — never the service-role key).
4. **Bootstrap the first admin** (SQL editor):
   ```sql
   insert into public.user_roles (user_id, role)
   select id, 'admin' from auth.users where email = 'you@example.com';
   ```
5. **Scheduling.** Migration 6 creates a `pg_cron` job (`meetwise-tick`, every minute) that advances lifecycle states, sends reveal notifications and applies retention with no extra setup. To have cron also *run matching and recommendations automatically*, enable `pg_net` and add two Vault secrets:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'meetwise_functions_url');
   select vault.create_secret('<service-role-key>', 'meetwise_service_role_key');
   ```
   Without these, organisers launch matching from the dashboard (reveal timing is still enforced by the server either way).
6. Auth: enable email provider; set Site URL / redirect URLs to your app domain.

### Dependencies that need configuration
- Vault secrets + `pg_net` for fully automatic matching (above).
- Email delivery: notifications are in-app; Supabase Auth sends only auth emails. Transactional email (e.g. "your match is ready") needs a provider such as Resend.
- Avatars use a public bucket with unguessable object names and are referenced only from visibility-filtered cards. Switch to signed URLs if photos must be strictly private.

## Development & testing

```bash
npm install
npm test            # unit: blossom algorithm vs brute force, scoring, matching, recommendations
npm run test:db     # integration: real migrations on local Postgres 16 + Supabase shim
npm run build
```

`test:db` runs every call the way PostgREST does (role `anon` / `authenticated` / `service_role` with JWT claims), so it checks access control against **direct API requests**: RLS on every table, column grants, service-only functions, reveal gating, mutual consent, idempotent retries, and a full lifecycle with 23+ synthetic attendees (odd counts, incomplete profiles, withdrawals, late arrivals, blocking, opt-outs).

Run the whole app locally without Docker (dev-only stand-in for the Supabase HTTP APIs):
```bash
bash scripts/local-db.sh            # throwaway Postgres 16 with migrations
npx tsx scripts/local-api.ts        # prints a local anon key
npx tsx scripts/seed-local.ts       # admin/organiser/attendees + a published event (password: meetwise-demo-123)
# put VITE_SUPABASE_URL=http://localhost:54321 and the printed key in .env.local
npx vite --host 127.0.0.1 --port 8080
npx tsx tests/e2e/walkthrough.ts <event-slug> ./shots   # Playwright click-through of the full flow
```
`scripts/local-api.ts`, `scripts/seed-local.ts` and `tests/db/shim` are for local testing only and are not deployed.

## Not in the MVP (by design)
AI résumé parsing, AI-generated recommendations, payments, swipe mechanics.
