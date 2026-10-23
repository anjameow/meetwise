-- Meetwise core schema: tables, enums, constraints and indexes.
-- All cross-user reads go through SECURITY DEFINER RPCs (see later migrations);
-- RLS is enabled on every table in 20261023000002_security.sql.

-- gen_random_uuid() is built into PostgreSQL 13+, no extension needed.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('attendee', 'organiser', 'admin');

create type public.event_status as enum (
  'draft',
  'registration_open',
  'registration_closed',
  'matching_in_progress',
  'primary_ready',
  'primary_revealed',
  'event_ended',
  'recommendations_available',
  'archived'
);

create type public.registration_status as enum ('registered', 'checked_in', 'withdrawn', 'removed');
create type public.match_round_status as enum ('running', 'completed', 'failed', 'superseded');
create type public.match_round_mode as enum ('primary', 'supplemental');
create type public.assignment_status as enum ('active', 'cancelled', 'superseded');
create type public.followup_choice as enum ('long_term', 'mentor', 'mentee', 'thanks');
create type public.connection_kind as enum ('connect', 'mentorship');
create type public.request_status as enum ('pending', 'accepted', 'declined', 'cancelled');
create type public.report_status as enum ('open', 'reviewing', 'resolved', 'dismissed');
create type public.application_status as enum ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------------------
-- Option vocabularies (kept in sync with src/lib/options.ts)
-- ---------------------------------------------------------------------------
create or replace function public.opt_industries() returns text[] language sql immutable as $$
  select array['technology','finance','investment','healthcare','biotech','education','consulting',
    'media','retail','manufacturing','energy','climate','government','nonprofit','legal',
    'real_estate','hospitality','transport','telecoms','other']
$$;
create or replace function public.opt_roles() returns text[] language sql immutable as $$
  select array['engineering','product','design','data','marketing','sales','finance','operations',
    'consulting','research','founder','recruiting','legal','healthcare','education','policy',
    'creative','investing','other']
$$;
create or replace function public.opt_goals() returns text[] language sql immutable as $$
  select array['find_job','hire_talent','find_mentor','mentor_others','start_company',
    'advise_founders','find_cofounder','raise_funding','invest','find_clients','change_careers',
    'share_career_advice','expand_network','learn_industry','collaborate_projects']
$$;
create or replace function public.opt_profile_fields() returns text[] language sql immutable as $$
  select array['photo','location','education','organisation','job_title','hobbies']
$$;
create or replace function public.opt_contact_fields() returns text[] language sql immutable as $$
  select array['linkedin','email','phone','links']
$$;

-- Tag lists: bounded count and element length.
create or replace function public.valid_tags(tags text[], max_count int, max_len int)
returns boolean language sql immutable as $$
  select tags is null or (
    coalesce(array_length(tags, 1), 0) <= max_count
    and not exists (select 1 from unnest(tags) t where t is null or char_length(btrim(t)) not between 1 and max_len)
  )
$$;

-- ---------------------------------------------------------------------------
-- Platform roles & settings
-- ---------------------------------------------------------------------------
create table public.user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.platform_settings (
  key text primary key check (key ~ '^[a-z_]{2,60}$'),
  value jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.platform_settings (key, value) values
  ('default_matching_weights', '{"goal_complementarity":30,"industry_role":25,"experience_mentorship":15,"professional_interests":15,"personal_interests":10,"location":5}'),
  ('default_role_rules', '{"exclude_same_organisation":true,"min_score":15,"auto_match_late_arrivals":true,"complementary_only":false,"recruiters_only_with_seekers":false}'),
  ('retention', '{"archive_events_after_days":30,"delete_resumes_after_days":180,"delete_notifications_after_days":180,"delete_audit_after_days":730}'),
  ('organiser_auto_approve', 'false'),
  ('privacy_notice_version', '"2026-10-01"');

create table public.organiser_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organisation text not null check (char_length(organisation) between 2 and 120),
  reason text not null check (char_length(reason) between 10 and 1000),
  status public.application_status not null default 'pending',
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  created_at timestamptz not null default now()
);
create unique index organiser_applications_one_pending on public.organiser_applications(user_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (char_length(btrim(full_name)) between 1 and 80),
  photo_path text check (photo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$'),
  city text check (char_length(city) <= 80),
  country text check (char_length(country) <= 60),
  education_status text check (education_status in ('high_school','undergraduate','postgraduate','doctoral','bootcamp','graduated','not_in_education')),
  university text check (char_length(university) <= 120),
  graduation_year int check (graduation_year between 1950 and 2040),
  organisation text check (char_length(organisation) <= 120),
  job_title text check (char_length(job_title) <= 100),
  role_category text check (role_category = any(public.opt_roles())),
  industry text check (industry = any(public.opt_industries())),
  employment_status text check (employment_status in ('employed','self_employed','founder','student','job_seeking','freelance','between_roles','other')),
  work_environment text check (work_environment in ('on_site','hybrid','remote','flexible')),
  career_stage text check (career_stage in ('student','early_career','mid_career','senior','executive')),
  career_goals text[] not null default '{}' check (career_goals <@ public.opt_goals() and coalesce(array_length(career_goals,1),0) <= 5),
  target_roles text[] not null default '{}' check (target_roles <@ public.opt_roles() and coalesce(array_length(target_roles,1),0) <= 5),
  target_industries text[] not null default '{}' check (target_industries <@ public.opt_industries() and coalesce(array_length(target_industries,1),0) <= 5),
  skills text[] not null default '{}' check (public.valid_tags(skills, 15, 40)),
  professional_interests text[] not null default '{}' check (public.valid_tags(professional_interests, 10, 40)),
  mentorship_preference text check (mentorship_preference in ('seeking','offering','both','open','none')),
  quirky_intro text check (char_length(quirky_intro) <= 160),
  hobbies text[] not null default '{}' check (public.valid_tags(hobbies, 10, 40)),
  onboarding_step int not null default 0 check (onboarding_step between 0 and 20),
  profile_completed_at timestamptz,
  suspended_at timestamptz,
  suspended_reason text,
  privacy_notice_accepted_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_industry_idx on public.profiles(industry);

-- Contact details live in a separate owner-only table so they can never leak
-- through a profile read.
create table public.profile_contacts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  linkedin_url text check (linkedin_url ~* '^https://([a-z]{2,3}\.)?(www\.)?linkedin\.com/[A-Za-z0-9/_%.-]{1,200}$'),
  email text check (email ~* '^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$'),
  phone text check (phone ~ '^\+?[0-9 ()-]{6,24}$'),
  other_links jsonb not null default '[]'::jsonb check (jsonb_typeof(other_links) = 'array' and jsonb_array_length(other_links) <= 3),
  updated_at timestamptz not null default now()
);

create table public.privacy_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  match_visible_fields text[] not null default array['photo','location','education','organisation','job_title','hobbies']
    check (match_visible_fields <@ public.opt_profile_fields()),
  recommendation_visible_fields text[] not null default array['photo','location','organisation','job_title']
    check (recommendation_visible_fields <@ public.opt_profile_fields()),
  match_contact_fields text[] not null default '{}' check (match_contact_fields <@ public.opt_contact_fields()),
  connection_contact_fields text[] not null default array['linkedin'] check (connection_contact_fields <@ public.opt_contact_fields()),
  resume_visibility text not null default 'nobody' check (resume_visibility in ('nobody','match','connections','match_and_connections')),
  updated_at timestamptz not null default now()
);

create table public.resumes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}\.pdf$'),
  file_name text not null check (char_length(file_name) between 1 and 200),
  size_bytes int not null check (size_bytes between 1 and 5242880),
  mime_type text not null check (mime_type = 'application/pdf'),
  uploaded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{3,79}$'),
  name text not null check (char_length(btrim(name)) between 3 and 120),
  tagline text check (char_length(tagline) <= 140),
  description text check (char_length(description) <= 4000),
  venue_name text check (char_length(venue_name) <= 120),
  venue_address text check (char_length(venue_address) <= 300),
  timezone text not null default 'UTC',
  accent_color text check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  starts_at timestamptz,
  ends_at timestamptz,
  registration_opens_at timestamptz,
  registration_deadline timestamptz,
  primary_reveal_at timestamptz,
  post_event_reveal_at timestamptz,
  status public.event_status not null default 'draft',
  is_paused boolean not null default false,
  capacity int check (capacity between 2 and 100000),
  access_code text check (access_code ~ '^[A-Za-z0-9-]{4,32}$'),
  allow_late_registration boolean not null default true,
  allowed_email_domains text[] not null default '{}' check (public.valid_tags(allowed_email_domains, 20, 120)),
  matching_weights jsonb not null,
  role_rules jsonb not null,
  recommendations_generated_at timestamptz,
  primary_notified_at timestamptz,
  recommendations_notified_at timestamptz,
  auto_match_failures int not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_time_order check (
    (starts_at is null or ends_at is null or starts_at < ends_at)
    and (registration_deadline is null or primary_reveal_at is null or registration_deadline <= primary_reveal_at)
    and (primary_reveal_at is null or post_event_reveal_at is null or primary_reveal_at < post_event_reveal_at)
    and (registration_opens_at is null or registration_deadline is null or registration_opens_at < registration_deadline)
  )
);
create index events_status_idx on public.events(status) where status not in ('draft', 'archived');

create table public.event_organisers (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'co_organiser')),
  added_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index event_organisers_user_idx on public.event_organisers(user_id);

create table public.event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status public.registration_status not null default 'registered',
  matching_consent boolean not null,
  recommendations_opt_in boolean not null default false,
  consent_version text not null,
  consented_at timestamptz not null default now(),
  is_late boolean not null default false,
  awaiting_match_since timestamptz,
  registered_at timestamptz not null default now(),
  checked_in_at timestamptz,
  withdrawn_at timestamptz,
  removed_reason text check (char_length(removed_reason) <= 300),
  updated_at timestamptz not null default now(),
  unique (event_id, user_id)
);
create index event_registrations_user_idx on public.event_registrations(user_id);
create index event_registrations_event_status_idx on public.event_registrations(event_id, status);

-- ---------------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------------
create table public.match_rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_number int not null check (round_number > 0),
  mode public.match_round_mode not null,
  status public.match_round_status not null default 'running',
  idempotency_key text check (char_length(idempotency_key) <= 100),
  weights jsonb not null,
  rules jsonb not null,
  algorithm text,
  eligible_count int not null default 0,
  matched_pairs int not null default 0,
  unmatched_count int not null default 0,
  error text,
  started_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (event_id, round_number),
  unique (event_id, idempotency_key)
);
-- At most one running job per event: concurrent launches cannot interleave.
create unique index match_rounds_one_running on public.match_rounds(event_id) where status = 'running';

create table public.match_assignments (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  user_a uuid references auth.users(id) on delete set null,
  user_b uuid references auth.users(id) on delete set null,
  score numeric(6,2) not null check (score >= 0 and score <= 100),
  breakdown jsonb not null default '{}'::jsonb,
  reasons jsonb not null default '{}'::jsonb,       -- {"a": [...], "b": [...]} phrased per viewer
  starters jsonb not null default '{}'::jsonb,      -- {"a": "...", "b": "..."}
  status public.assignment_status not null default 'active',
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason in ('withdrawal','removed','blocked','organiser','account_deleted','consent_revoked')),
  created_at timestamptz not null default now(),
  check (user_a is null or user_b is null or user_a < user_b),
  unique (round_id, user_a),
  unique (round_id, user_b)
);
create index match_assignments_event_idx on public.match_assignments(event_id);
create index match_assignments_user_a_idx on public.match_assignments(user_a);
create index match_assignments_user_b_idx on public.match_assignments(user_b);

-- Everyone considered in a round (matched or not). The partial unique index
-- guarantees at most one active primary match per attendee per event,
-- across all rounds, at the database level.
create table public.match_round_members (
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  assignment_id uuid references public.match_assignments(id) on delete set null,
  assignment_active boolean not null default false,
  primary key (round_id, user_id)
);
create unique index match_round_members_one_active
  on public.match_round_members(event_id, user_id) where assignment_active;
create index match_round_members_user_idx on public.match_round_members(user_id, event_id);

create table public.match_followups (
  assignment_id uuid not null references public.match_assignments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  choice public.followup_choice not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (assignment_id, user_id)
);

create table public.match_feedback (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.match_assignments(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  rating int not null check (rating between 1 and 5),
  met_in_person boolean not null,
  event_rating int check (event_rating between 1 and 5),
  comment text check (char_length(comment) <= 1000),
  created_at timestamptz not null default now(),
  unique (assignment_id, user_id)
);
create index match_feedback_event_idx on public.match_feedback(event_id);

-- ---------------------------------------------------------------------------
-- Post-event recommendations
-- ---------------------------------------------------------------------------
create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  recommended_user_id uuid not null references auth.users(id) on delete cascade,
  rank int not null check (rank between 1 and 5),
  score numeric(6,2) not null check (score >= 0 and score <= 100),
  reasons text[] not null default '{}',
  generated_at timestamptz not null default now(),
  check (user_id <> recommended_user_id),
  unique (event_id, user_id, recommended_user_id),
  unique (event_id, user_id, rank)
);
create index recommendations_recommended_idx on public.recommendations(recommended_user_id);

create table public.saved_profiles (
  user_id uuid not null references auth.users(id) on delete cascade,
  saved_user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, saved_user_id),
  check (user_id <> saved_user_id)
);

-- ---------------------------------------------------------------------------
-- Connections (always mutual)
-- ---------------------------------------------------------------------------
create table public.connection_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  kind public.connection_kind not null default 'connect',
  requester_mentorship_role text check (requester_mentorship_role in ('mentor','mentee')),
  message text check (char_length(message) <= 300),
  status public.request_status not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> recipient_id),
  check ((kind = 'mentorship') = (requester_mentorship_role is not null))
);
create unique index connection_requests_one_pending
  on public.connection_requests(requester_id, recipient_id, kind) where status = 'pending';
create index connection_requests_recipient_idx on public.connection_requests(recipient_id, status);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  kind public.connection_kind not null,
  mentor_id uuid references auth.users(id) on delete cascade,
  source text not null check (source in ('primary_followup','request')),
  event_id uuid references public.events(id) on delete set null,
  created_at timestamptz not null default now(),
  check (user_a < user_b),
  check (mentor_id is null or mentor_id in (user_a, user_b)),
  check ((kind = 'mentorship') = (mentor_id is not null)),
  unique (user_a, user_b, kind)
);
create index connections_user_b_idx on public.connections(user_b);

-- ---------------------------------------------------------------------------
-- Safety
-- ---------------------------------------------------------------------------
create table public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks(blocked_id);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users(id) on delete set null,
  reported_user_id uuid references auth.users(id) on delete set null,
  event_id uuid references public.events(id) on delete set null,
  category text not null check (category in ('harassment','inappropriate_content','spam','fake_profile','safety_concern','other')),
  details text check (char_length(details) <= 2000),
  status public.report_status not null default 'open',
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolution_note text check (char_length(resolution_note) <= 1000),
  created_at timestamptz not null default now(),
  check (reporter_id is null or reported_user_id is null or reporter_id <> reported_user_id)
);
create index reports_status_idx on public.reports(status, created_at desc);

-- ---------------------------------------------------------------------------
-- Notifications, audit, rate limits
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (char_length(type) <= 60),
  title text not null check (char_length(title) <= 140),
  body text check (char_length(body) <= 500),
  link text check (link ~ '^/[A-Za-z0-9/_?=&%.-]*$'),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  event_id uuid references public.events(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_event_idx on public.audit_logs(event_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs(created_at desc);

create table public.rate_limit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);
create index rate_limit_events_idx on public.rate_limit_events(user_id, action, created_at desc);

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create or replace function public.tg_touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.tg_touch_updated_at();
create trigger profile_contacts_touch before update on public.profile_contacts for each row execute function public.tg_touch_updated_at();
create trigger privacy_settings_touch before update on public.privacy_settings for each row execute function public.tg_touch_updated_at();
create trigger events_touch before update on public.events for each row execute function public.tg_touch_updated_at();
create trigger event_registrations_touch before update on public.event_registrations for each row execute function public.tg_touch_updated_at();
create trigger match_followups_touch before update on public.match_followups for each row execute function public.tg_touch_updated_at();

-- Profile completeness is decided by the server, never the client.
create or replace function public.profile_is_complete(p public.profiles) returns boolean language sql immutable as $$
  select p.full_name is not null
    and p.city is not null and p.country is not null
    and p.employment_status is not null
    and p.career_stage is not null
    and p.industry is not null
    and p.role_category is not null
    and coalesce(array_length(p.career_goals, 1), 0) >= 1
    and (coalesce(array_length(p.skills, 1), 0) + coalesce(array_length(p.professional_interests, 1), 0)) >= 1
    and p.mentorship_preference is not null
    and p.quirky_intro is not null and char_length(btrim(p.quirky_intro)) >= 10
$$;

create or replace function public.tg_profile_completion() returns trigger language plpgsql as $$
begin
  if public.profile_is_complete(new) then
    new.profile_completed_at := coalesce(new.profile_completed_at, now());
  else
    new.profile_completed_at := null;
  end if;
  return new;
end $$;
create trigger profiles_completion before insert or update on public.profiles
  for each row execute function public.tg_profile_completion();

create or replace function public.tg_validate_event_timezone() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'invalid_timezone' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger events_timezone before insert or update of timezone on public.events
  for each row execute function public.tg_validate_event_timezone();

-- New auth user -> profile + privacy + contacts rows (contacts default empty).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 80), ''))
  on conflict (id) do nothing;
  insert into public.privacy_settings (user_id) values (new.id) on conflict do nothing;
  insert into public.profile_contacts (user_id) values (new.id) on conflict do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'attendee') on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
