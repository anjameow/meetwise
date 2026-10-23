-- Meetwise security layer: internal helpers, Row Level Security, column grants
-- and private storage.
--
-- Principle: attendees can read and write only their own rows directly.
-- Anything involving another person's data (matches, recommendations,
-- connection requests, organiser views) is served by SECURITY DEFINER RPCs
-- that apply consent, visibility and server-time checks.

-- Internal helpers live in a schema that PostgREST does not expose.
create schema if not exists private;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Authorisation helpers
-- ---------------------------------------------------------------------------
create or replace function private.user_has_role(p_user uuid, p_role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = p_user and role = p_role)
$$;

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and private.user_has_role(auth.uid(), 'admin')
$$;

create or replace function private.is_event_organiser(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    exists (select 1 from public.event_organisers where event_id = p_event and user_id = auth.uid())
    or private.user_has_role(auth.uid(), 'admin')
  )
$$;

create or replace function private.is_blocked(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a)
  )
$$;

create or replace function private.require_auth() returns uuid
language plpgsql stable as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  return v;
end $$;

create or replace function private.require_organiser(p_event uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid := private.require_auth();
begin
  if not private.is_event_organiser(p_event) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function private.require_admin() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid := private.require_auth();
begin
  if not private.user_has_role(v, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v;
end $$;

-- Sliding-window rate limit per user and action.
create or replace function private.enforce_rate_limit(p_action text, p_max int, p_window interval)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid := private.require_auth(); v_count int;
begin
  select count(*) into v_count from public.rate_limit_events
   where user_id = v_user and action = p_action and created_at > now() - p_window;
  if v_count >= p_max then
    raise exception 'rate_limited' using errcode = 'P0001', hint = p_action;
  end if;
  insert into public.rate_limit_events (user_id, action) values (v_user, p_action);
end $$;

create or replace function private.notify(p_user uuid, p_type text, p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, type, title, body, link)
  select p_user, p_type, p_title, p_body, p_link where p_user is not null
$$;

create or replace function private.audit(p_event uuid, p_action text, p_target_type text, p_target_id text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_logs (actor_id, event_id, action, target_type, target_id, details)
  values (auth.uid(), p_event, p_action, p_target_type, p_target_id, coalesce(p_details, '{}'::jsonb))
$$;

-- Has the primary reveal for this event been authorised by the server clock?
create or replace function private.primary_revealed(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event and not e.is_paused
      and e.primary_reveal_at is not null and e.primary_reveal_at <= now()
      and e.status not in ('draft', 'archived')
  )
$$;

create or replace function private.recommendations_revealed(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event and not e.is_paused
      and e.post_event_reveal_at is not null and e.post_event_reveal_at <= now()
      and e.recommendations_generated_at is not null
      and e.status not in ('draft', 'archived')
  )
$$;

-- Is there a revealed, active primary match between two users?
create or replace function private.revealed_match_between(p_a uuid, p_b uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select a.id from public.match_assignments a
  join public.match_rounds r on r.id = a.round_id and r.status = 'completed'
  where a.status = 'active'
    and ((a.user_a = p_a and a.user_b = p_b) or (a.user_a = p_b and a.user_b = p_a))
    and private.primary_revealed(a.event_id)
  limit 1
$$;

-- Has p_viewer been shown p_subject as a revealed recommendation?
create or replace function private.revealed_recommendation(p_viewer uuid, p_subject uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.recommendations r
    where r.user_id = p_viewer and r.recommended_user_id = p_subject
      and private.recommendations_revealed(r.event_id)
  )
$$;

create or replace function private.connected(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.connections c
                 where c.user_a = least(p_a, p_b) and c.user_b = greatest(p_a, p_b))
$$;

-- ---------------------------------------------------------------------------
-- Visibility-filtered profile card. Context decides which fields and which
-- contact details are included:
--   match          -> match_visible_fields  + match_contact_fields
--   recommendation -> recommendation_visible_fields, no contacts
--   request        -> recommendation_visible_fields, no contacts
--   connection     -> match_visible_fields  + connection_contact_fields
-- Callers are responsible for checking that the viewer is entitled to the
-- context. Sensitive characteristics are never stored, so never returned.
-- ---------------------------------------------------------------------------
create or replace function private.profile_card(p_subject uuid, p_context text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p public.profiles;
  s public.privacy_settings;
  c public.profile_contacts;
  v_fields text[];
  v_contacts text[];
  v_res jsonb;
  v_contact jsonb := '{}'::jsonb;
  v_resume boolean := false;
begin
  select * into p from public.profiles where id = p_subject;
  if not found then return null; end if;
  select * into s from public.privacy_settings where user_id = p_subject;

  v_fields := case p_context
    when 'match' then s.match_visible_fields
    when 'connection' then s.match_visible_fields
    else s.recommendation_visible_fields end;
  v_contacts := case p_context
    when 'match' then s.match_contact_fields
    when 'connection' then s.connection_contact_fields
    else '{}'::text[] end;

  v_res := jsonb_build_object(
    'id', p.id,
    'full_name', p.full_name,
    'first_name', split_part(coalesce(p.full_name, ''), ' ', 1),
    'role_category', p.role_category,
    'industry', p.industry,
    'employment_status', p.employment_status,
    'career_stage', p.career_stage,
    'career_goals', to_jsonb(p.career_goals),
    'target_roles', to_jsonb(p.target_roles),
    'target_industries', to_jsonb(p.target_industries),
    'skills', to_jsonb(p.skills),
    'professional_interests', to_jsonb(p.professional_interests),
    'mentorship_preference', p.mentorship_preference,
    'quirky_intro', p.quirky_intro
  );
  if 'photo' = any(v_fields) then v_res := v_res || jsonb_build_object('photo_path', p.photo_path); end if;
  if 'location' = any(v_fields) then v_res := v_res || jsonb_build_object('city', p.city, 'country', p.country); end if;
  if 'education' = any(v_fields) then
    v_res := v_res || jsonb_build_object('education_status', p.education_status, 'university', p.university, 'graduation_year', p.graduation_year);
  end if;
  if 'organisation' = any(v_fields) then v_res := v_res || jsonb_build_object('organisation', p.organisation); end if;
  if 'job_title' = any(v_fields) then v_res := v_res || jsonb_build_object('job_title', p.job_title); end if;
  if 'hobbies' = any(v_fields) then v_res := v_res || jsonb_build_object('hobbies', to_jsonb(p.hobbies)); end if;

  if coalesce(array_length(v_contacts, 1), 0) > 0 then
    select * into c from public.profile_contacts where user_id = p_subject;
    if 'linkedin' = any(v_contacts) and c.linkedin_url is not null then v_contact := v_contact || jsonb_build_object('linkedin', c.linkedin_url); end if;
    if 'email' = any(v_contacts) and c.email is not null then v_contact := v_contact || jsonb_build_object('email', c.email); end if;
    if 'phone' = any(v_contacts) and c.phone is not null then v_contact := v_contact || jsonb_build_object('phone', c.phone); end if;
    if 'links' = any(v_contacts) and jsonb_array_length(c.other_links) > 0 then v_contact := v_contact || jsonb_build_object('links', c.other_links); end if;
  end if;
  v_res := v_res || jsonb_build_object('contacts', v_contact);

  if exists (select 1 from public.resumes where user_id = p_subject) then
    v_resume := (p_context = 'match' and s.resume_visibility in ('match', 'match_and_connections'))
             or (p_context = 'connection' and s.resume_visibility in ('connections', 'match_and_connections'));
  end if;
  v_res := v_res || jsonb_build_object('resume_available', v_resume);
  return v_res;
end $$;

-- ---------------------------------------------------------------------------
-- Public (API-exposed) helper RPCs for the current user.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select private.is_admin() $$;

create or replace function public.is_event_organiser(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$ select private.is_event_organiser(p_event) $$;

create or replace function public.my_roles() returns public.app_role[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(role order by role), '{}') from public.user_roles where user_id = auth.uid()
$$;

-- Resume access is separate from profile access: owner, a revealed primary
-- match, or a mutual connection, and only if the owner's setting allows it.
create or replace function public.can_view_resume(p_owner uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_viewer uuid := auth.uid(); v_vis text;
begin
  if v_viewer is null then return false; end if;
  if v_viewer = p_owner then return exists (select 1 from public.resumes where user_id = p_owner); end if;
  if not exists (select 1 from public.resumes where user_id = p_owner) then return false; end if;
  if private.is_blocked(v_viewer, p_owner) then return false; end if;
  select resume_visibility into v_vis from public.privacy_settings where user_id = p_owner;
  if v_vis in ('match', 'match_and_connections') and private.revealed_match_between(v_viewer, p_owner) is not null then
    return true;
  end if;
  if v_vis in ('connections', 'match_and_connections') and private.connected(v_viewer, p_owner) then
    return true;
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.user_roles enable row level security;
alter table public.platform_settings enable row level security;
alter table public.organiser_applications enable row level security;
alter table public.profiles enable row level security;
alter table public.profile_contacts enable row level security;
alter table public.privacy_settings enable row level security;
alter table public.resumes enable row level security;
alter table public.events enable row level security;
alter table public.event_organisers enable row level security;
alter table public.event_registrations enable row level security;
alter table public.match_rounds enable row level security;
alter table public.match_assignments enable row level security;
alter table public.match_round_members enable row level security;
alter table public.match_followups enable row level security;
alter table public.match_feedback enable row level security;
alter table public.recommendations enable row level security;
alter table public.saved_profiles enable row level security;
alter table public.connection_requests enable row level security;
alter table public.connections enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.rate_limit_events enable row level security;

-- Anonymous visitors never touch tables directly; they use get_event_public().
revoke all on all tables in schema public from anon;
-- Authenticated users write only through RPCs, except for the explicit
-- column grants below.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;

create policy user_roles_select_own on public.user_roles for select to authenticated
  using (user_id = auth.uid() or private.is_admin());

create policy platform_settings_read on public.platform_settings for select to authenticated using (true);

create policy organiser_applications_own on public.organiser_applications for select to authenticated
  using (user_id = auth.uid() or private.is_admin());

-- Profiles: only the owner (and platform admins for moderation).
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = auth.uid() or private.is_admin());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
grant update (full_name, photo_path, city, country, education_status, university, graduation_year,
  organisation, job_title, role_category, industry, employment_status, work_environment, career_stage,
  career_goals, target_roles, target_industries, skills, professional_interests, mentorship_preference,
  quirky_intro, hobbies, onboarding_step, privacy_notice_accepted_version)
  on public.profiles to authenticated;

create policy profile_contacts_own on public.profile_contacts for select to authenticated using (user_id = auth.uid());
create policy profile_contacts_update_own on public.profile_contacts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant update (linkedin_url, email, phone, other_links) on public.profile_contacts to authenticated;

create policy privacy_settings_own on public.privacy_settings for select to authenticated using (user_id = auth.uid());
create policy privacy_settings_update_own on public.privacy_settings for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant update (match_visible_fields, recommendation_visible_fields, match_contact_fields,
  connection_contact_fields, resume_visibility) on public.privacy_settings to authenticated;

create policy resumes_own on public.resumes for select to authenticated using (user_id = auth.uid());

-- Events: organisers of the event and admins. Attendees use RPCs, which hide
-- the access code and matching configuration.
create policy events_organiser_select on public.events for select to authenticated
  using (private.is_event_organiser(id));
create policy event_organisers_select on public.event_organisers for select to authenticated
  using (user_id = auth.uid() or private.is_event_organiser(event_id));

create policy registrations_select on public.event_registrations for select to authenticated
  using (user_id = auth.uid() or private.is_event_organiser(event_id));

-- Matching data: organisers can review; attendees go through the reveal-gated
-- RPCs. Recommendations have no direct-read policy at all.
create policy match_rounds_organiser on public.match_rounds for select to authenticated
  using (private.is_event_organiser(event_id));
create policy match_assignments_organiser on public.match_assignments for select to authenticated
  using (private.is_event_organiser(event_id));
create policy match_round_members_organiser on public.match_round_members for select to authenticated
  using (private.is_event_organiser(event_id));

-- A follow-up decision is private to the person who made it.
create policy match_followups_own on public.match_followups for select to authenticated
  using (user_id = auth.uid());

create policy match_feedback_own on public.match_feedback for select to authenticated
  using (user_id = auth.uid());

create policy saved_profiles_own on public.saved_profiles for select to authenticated
  using (user_id = auth.uid());

create policy connections_party on public.connections for select to authenticated
  using (auth.uid() in (user_a, user_b));

-- connection_requests: no direct read policy. my_connection_requests() masks
-- declines so a requester never learns about a private "no".

create policy blocks_own on public.blocks for select to authenticated using (blocker_id = auth.uid());

create policy reports_own on public.reports for select to authenticated
  using (reporter_id = auth.uid() or private.is_admin());

create policy notifications_own on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update_own on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete_own on public.notifications for delete to authenticated using (user_id = auth.uid());
grant update (read_at) on public.notifications to authenticated;
grant delete on public.notifications to authenticated;

create policy audit_logs_read on public.audit_logs for select to authenticated
  using (private.is_admin() or (event_id is not null and private.is_event_organiser(event_id)));

-- rate_limit_events: no policies (service only).

-- ---------------------------------------------------------------------------
-- Storage: resumes are private, avatars are served from a public bucket using
-- unguessable object names and are only referenced from visibility-filtered
-- profile cards.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 5242880, array['application/pdf']),
       ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Owners manage their own folder. Nobody else can read resumes through the
-- Storage API; other viewers get a short-lived signed URL from the
-- resume-url edge function after can_view_resume() passes.
create policy "resumes: owner read" on storage.objects for select to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resumes: owner insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resumes: owner update" on storage.objects for update to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "resumes: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars: owner insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars: owner update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
