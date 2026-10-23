-- Organiser dashboard RPCs and the service-only matching job interface.

-- ---------------------------------------------------------------------------
-- Validation helpers
-- ---------------------------------------------------------------------------
create or replace function private.validate_weights(p jsonb) returns jsonb
language plpgsql immutable as $$
declare
  v_keys text[] := array['goal_complementarity','industry_role','experience_mentorship','professional_interests','personal_interests','location'];
  k text; v_total numeric := 0; v_out jsonb := '{}'::jsonb; v numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_input:weights' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_object_keys(p) x where x <> all(v_keys)) then
    raise exception 'invalid_input:weights_unknown_key' using errcode = '22023';
  end if;
  foreach k in array v_keys loop
    if jsonb_typeof(p -> k) <> 'number' then raise exception 'invalid_input:weights_missing_%', k using errcode = '22023'; end if;
    v := (p ->> k)::numeric;
    if v < 0 or v > 100 then raise exception 'invalid_input:weights_range' using errcode = '22023'; end if;
    v_total := v_total + v;
    v_out := v_out || jsonb_build_object(k, v);
  end loop;
  if v_total <= 0 then raise exception 'invalid_input:weights_zero' using errcode = '22023'; end if;
  return v_out;
end $$;

create or replace function private.validate_rules(p jsonb) returns jsonb
language plpgsql immutable as $$
declare v_out jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_input:rules' using errcode = '22023'; end if;
  v_out := jsonb_build_object(
    'exclude_same_organisation', coalesce((p ->> 'exclude_same_organisation')::boolean, true),
    'min_score', coalesce((p ->> 'min_score')::numeric, 15),
    'auto_match_late_arrivals', coalesce((p ->> 'auto_match_late_arrivals')::boolean, true),
    'complementary_only', coalesce((p ->> 'complementary_only')::boolean, false),
    'recruiters_only_with_seekers', coalesce((p ->> 'recruiters_only_with_seekers')::boolean, false)
  );
  if (v_out ->> 'min_score')::numeric not between 0 and 90 then
    raise exception 'invalid_input:min_score' using errcode = '22023';
  end if;
  return v_out;
end $$;

-- Organiser enters wall-clock times in the event's timezone; the server
-- converts to UTC so there is one authoritative clock.
create or replace function private.local_ts(p jsonb, k text, tz text) returns timestamptz
language plpgsql stable as $$
begin
  if p ? k is false or p ->> k is null or p ->> k = '' then return null; end if;
  return ((p ->> k)::timestamp) at time zone tz;
exception when others then
  raise exception 'invalid_input:%', k using errcode = '22023';
end $$;

create or replace function private.make_slug(p_name text) returns text
language plpgsql volatile as $$
declare v_base text;
begin
  v_base := trim(both '-' from left(regexp_replace(lower(coalesce(p_name, 'event')), '[^a-z0-9]+', '-', 'g'), 40));
  if char_length(v_base) < 3 then v_base := 'event'; end if;
  return v_base || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
end $$;

create or replace function private.check_publishable(e public.events) returns void
language plpgsql stable as $$
begin
  if e.starts_at is null or e.ends_at is null or e.registration_deadline is null
     or e.primary_reveal_at is null or e.post_event_reveal_at is null then
    raise exception 'invalid_input:schedule_incomplete' using errcode = '22023';
  end if;
  if e.primary_reveal_at > e.ends_at then
    raise exception 'invalid_input:primary_reveal_after_end' using errcode = '22023';
  end if;
  if e.post_event_reveal_at < e.ends_at then
    raise exception 'invalid_input:post_reveal_before_end' using errcode = '22023';
  end if;
end $$;

create or replace function private.event_counts(p_event uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with regs as (
    select r.*, p.profile_completed_at, p.suspended_at from public.event_registrations r
    join public.profiles p on p.id = r.user_id where r.event_id = p_event
  ), active as (select * from regs where status in ('registered', 'checked_in')),
  eligible as (select * from active where matching_consent and profile_completed_at is not null and suspended_at is null),
  matched as (select distinct user_id from public.match_round_members where event_id = p_event and assignment_active)
  select jsonb_build_object(
    'registered', (select count(*) from active),
    'checked_in', (select count(*) from active where status = 'checked_in'),
    'profiles_complete', (select count(*) from active where profile_completed_at is not null),
    'matching_consent', (select count(*) from active where matching_consent),
    'recommendations_opt_in', (select count(*) from active where recommendations_opt_in),
    'eligible', (select count(*) from eligible),
    'matched', (select count(*) from eligible where user_id in (select user_id from matched)),
    'unmatched_eligible', (select count(*) from eligible where user_id not in (select user_id from matched)),
    'awaiting_match', (select count(*) from eligible where awaiting_match_since is not null and user_id not in (select user_id from matched)),
    'late', (select count(*) from active where is_late),
    'withdrawn', (select count(*) from regs where status = 'withdrawn'),
    'removed', (select count(*) from regs where status = 'removed')
  )
$$;

-- ---------------------------------------------------------------------------
-- Event CRUD
-- ---------------------------------------------------------------------------
create or replace function private.apply_event_payload(e public.events, p jsonb) returns public.events
language plpgsql stable as $$
declare v_tz text := coalesce(nullif(p ->> 'timezone', ''), e.timezone, 'UTC');
begin
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    raise exception 'invalid_input:timezone' using errcode = '22023';
  end if;
  e.timezone := v_tz;
  if p ? 'name' then e.name := btrim(p ->> 'name'); end if;
  if p ? 'tagline' then e.tagline := nullif(btrim(p ->> 'tagline'), ''); end if;
  if p ? 'description' then e.description := nullif(btrim(p ->> 'description'), ''); end if;
  if p ? 'venue_name' then e.venue_name := nullif(btrim(p ->> 'venue_name'), ''); end if;
  if p ? 'venue_address' then e.venue_address := nullif(btrim(p ->> 'venue_address'), ''); end if;
  if p ? 'accent_color' then e.accent_color := nullif(p ->> 'accent_color', ''); end if;
  if p ? 'capacity' then e.capacity := nullif(p ->> 'capacity', '')::int; end if;
  if p ? 'access_code' then e.access_code := nullif(btrim(p ->> 'access_code'), ''); end if;
  if p ? 'allow_late_registration' then e.allow_late_registration := (p ->> 'allow_late_registration')::boolean; end if;
  if p ? 'allowed_email_domains' then
    e.allowed_email_domains := coalesce((select array_agg(lower(btrim(x))) from jsonb_array_elements_text(p -> 'allowed_email_domains') x
                                         where btrim(x) <> ''), '{}');
  end if;
  if p ? 'starts_at' then e.starts_at := private.local_ts(p, 'starts_at', v_tz); end if;
  if p ? 'ends_at' then e.ends_at := private.local_ts(p, 'ends_at', v_tz); end if;
  if p ? 'registration_opens_at' then e.registration_opens_at := private.local_ts(p, 'registration_opens_at', v_tz); end if;
  if p ? 'registration_deadline' then e.registration_deadline := private.local_ts(p, 'registration_deadline', v_tz); end if;
  if p ? 'primary_reveal_at' then e.primary_reveal_at := private.local_ts(p, 'primary_reveal_at', v_tz); end if;
  if p ? 'post_event_reveal_at' then e.post_event_reveal_at := private.local_ts(p, 'post_event_reveal_at', v_tz); end if;
  return e;
end $$;

create or replace function public.create_event(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); e public.events; v_weights jsonb; v_rules jsonb;
begin
  if not (private.user_has_role(v_uid, 'organiser') or private.user_has_role(v_uid, 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.enforce_rate_limit('create_event', 30, interval '1 day');
  select value into v_weights from public.platform_settings where key = 'default_matching_weights';
  select value into v_rules from public.platform_settings where key = 'default_role_rules';

  e.id := gen_random_uuid();
  e.slug := private.make_slug(p ->> 'name');
  e.timezone := 'UTC';
  e := private.apply_event_payload(e, p);
  insert into public.events (id, slug, name, tagline, description, venue_name, venue_address, timezone, accent_color,
    starts_at, ends_at, registration_opens_at, registration_deadline, primary_reveal_at, post_event_reveal_at,
    capacity, access_code, allow_late_registration, allowed_email_domains, matching_weights, role_rules, created_by)
  values (e.id, e.slug, e.name, e.tagline, e.description, e.venue_name, e.venue_address, e.timezone, e.accent_color,
    e.starts_at, e.ends_at, e.registration_opens_at, e.registration_deadline, e.primary_reveal_at, e.post_event_reveal_at,
    e.capacity, e.access_code, coalesce(e.allow_late_registration, true), coalesce(e.allowed_email_domains, '{}'),
    private.validate_weights(coalesce(p -> 'matching_weights', v_weights)),
    private.validate_rules(coalesce(p -> 'role_rules', v_rules)), v_uid)
  returning * into e;
  insert into public.event_organisers (event_id, user_id, role) values (e.id, v_uid, 'owner');
  perform private.audit(e.id, 'event.created', 'event', e.id::text);
  return jsonb_build_object('id', e.id, 'slug', e.slug);
end $$;

create or replace function public.update_event(p_event uuid, p jsonb, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := private.require_organiser(p_event);
  e_old public.events; e public.events; v_sched_changed boolean; v_user uuid;
begin
  select * into e_old from public.events where id = p_event for update;
  if e_old.status = 'archived' then raise exception 'event_archived' using errcode = 'P0001'; end if;
  e := private.apply_event_payload(e_old, p);

  v_sched_changed := (e.starts_at, e.ends_at, e.registration_opens_at, e.registration_deadline, e.primary_reveal_at, e.post_event_reveal_at, e.timezone)
    is distinct from (e_old.starts_at, e_old.ends_at, e_old.registration_opens_at, e_old.registration_deadline, e_old.primary_reveal_at, e_old.post_event_reveal_at, e_old.timezone);

  if v_sched_changed and e_old.status <> 'draft' then
    if not p_confirm then
      raise exception 'confirmation_required' using errcode = 'P0001', hint = 'schedule_change';
    end if;
    if private.primary_revealed(p_event) and e.primary_reveal_at is distinct from e_old.primary_reveal_at then
      raise exception 'invalid_input:primary_already_revealed' using errcode = '22023';
    end if;
    if private.recommendations_revealed(p_event) and e.post_event_reveal_at is distinct from e_old.post_event_reveal_at then
      raise exception 'invalid_input:recommendations_already_revealed' using errcode = '22023';
    end if;
    perform private.check_publishable(e);
  end if;

  update public.events set name = e.name, tagline = e.tagline, description = e.description, venue_name = e.venue_name,
    venue_address = e.venue_address, timezone = e.timezone, accent_color = e.accent_color, starts_at = e.starts_at,
    ends_at = e.ends_at, registration_opens_at = e.registration_opens_at, registration_deadline = e.registration_deadline,
    primary_reveal_at = e.primary_reveal_at, post_event_reveal_at = e.post_event_reveal_at, capacity = e.capacity,
    access_code = e.access_code, allow_late_registration = e.allow_late_registration,
    allowed_email_domains = e.allowed_email_domains,
    -- Moving the deadline into the future re-opens registration if matching hasn't run.
    status = case when e_old.status = 'registration_closed' and e.registration_deadline > now()
                   and not exists (select 1 from public.match_rounds where event_id = p_event and status in ('running', 'completed'))
                  then 'registration_open'::public.event_status else e_old.status end
  where id = p_event;

  if v_sched_changed and e_old.status <> 'draft' then
    perform private.audit(p_event, 'event.schedule_changed', 'event', p_event::text, jsonb_build_object(
      'before', jsonb_build_object('registration_deadline', e_old.registration_deadline, 'primary_reveal_at', e_old.primary_reveal_at,
                                   'post_event_reveal_at', e_old.post_event_reveal_at, 'starts_at', e_old.starts_at, 'ends_at', e_old.ends_at),
      'after', jsonb_build_object('registration_deadline', e.registration_deadline, 'primary_reveal_at', e.primary_reveal_at,
                                  'post_event_reveal_at', e.post_event_reveal_at, 'starts_at', e.starts_at, 'ends_at', e.ends_at)));
    for v_user in select user_id from public.event_registrations where event_id = p_event and status in ('registered', 'checked_in') loop
      perform private.notify(v_user, 'schedule_changed', 'Schedule update: ' || e.name,
        'The organiser updated the event schedule. Check the latest times.', '/e/' || e.slug);
    end loop;
  else
    perform private.audit(p_event, 'event.updated', 'event', p_event::text);
  end if;
  return jsonb_build_object('id', p_event, 'schedule_changed', v_sched_changed);
end $$;

create or replace function public.duplicate_event(p_event uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event); e public.events; v_id uuid := gen_random_uuid(); v_slug text;
begin
  select * into e from public.events where id = p_event;
  v_slug := private.make_slug(e.name);
  insert into public.events (id, slug, name, tagline, description, venue_name, venue_address, timezone, accent_color,
    capacity, access_code, allow_late_registration, allowed_email_domains, matching_weights, role_rules, created_by)
  values (v_id, v_slug, left(e.name || ' (copy)', 120), e.tagline, e.description, e.venue_name, e.venue_address, e.timezone,
    e.accent_color, e.capacity, e.access_code, e.allow_late_registration, e.allowed_email_domains,
    e.matching_weights, e.role_rules, v_uid);
  insert into public.event_organisers (event_id, user_id, role) values (v_id, v_uid, 'owner');
  perform private.audit(v_id, 'event.duplicated', 'event', v_id::text, jsonb_build_object('source', p_event));
  return jsonb_build_object('id', v_id, 'slug', v_slug);
end $$;

create or replace function public.set_event_status(p_event uuid, p_action text, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event); e public.events; v_new public.event_status; v_paused boolean;
begin
  select * into e from public.events where id = p_event for update;
  v_new := e.status; v_paused := e.is_paused;

  if p_action <> 'publish' and not p_confirm then
    raise exception 'confirmation_required' using errcode = 'P0001', hint = p_action;
  end if;

  case p_action
    when 'publish' then
      if e.status <> 'draft' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
      perform private.check_publishable(e);
      if e.registration_deadline <= now() then raise exception 'invalid_input:deadline_in_past' using errcode = '22023'; end if;
      v_new := 'registration_open';
      update public.events set published_at = now() where id = p_event;
    when 'close_registration' then
      if e.status <> 'registration_open' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
      v_new := 'registration_closed';
      update public.events set registration_deadline = least(registration_deadline, now()) where id = p_event;
    when 'reopen_registration' then
      if e.status <> 'registration_closed' or e.registration_deadline <= now()
         or exists (select 1 from public.match_rounds where event_id = p_event and status in ('running', 'completed')) then
        raise exception 'invalid_transition' using errcode = 'P0001';
      end if;
      v_new := 'registration_open';
    when 'pause' then
      if e.status in ('draft', 'archived') then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
      v_paused := true;
    when 'resume' then
      v_paused := false;
    when 'end' then
      if e.status in ('draft', 'archived', 'event_ended', 'recommendations_available') then
        raise exception 'invalid_transition' using errcode = 'P0001';
      end if;
      v_new := 'event_ended';
      update public.events set ends_at = least(ends_at, now()) where id = p_event;
      update public.event_registrations set awaiting_match_since = null where event_id = p_event;
    when 'archive' then
      if e.status = 'archived' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
      v_new := 'archived';
      update public.events set archived_at = now() where id = p_event;
    else
      raise exception 'invalid_input:action' using errcode = '22023';
  end case;

  update public.events set status = v_new, is_paused = v_paused where id = p_event;
  perform private.audit(p_event, 'event.' || p_action, 'event', p_event::text,
    jsonb_build_object('from', e.status, 'to', v_new, 'paused', v_paused));
  return jsonb_build_object('status', v_new, 'is_paused', v_paused);
end $$;

create or replace function public.update_matching_config(p_event uuid, p_weights jsonb, p_rules jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event); v_w jsonb; v_r jsonb;
begin
  v_w := private.validate_weights(p_weights);
  v_r := private.validate_rules(p_rules);
  update public.events set matching_weights = v_w, role_rules = v_r where id = p_event;
  perform private.audit(p_event, 'matching.config_updated', 'event', p_event::text, jsonb_build_object('weights', v_w, 'rules', v_r));
  return jsonb_build_object('matching_weights', v_w, 'role_rules', v_r);
end $$;

create or replace function public.add_co_organiser(p_event uuid, p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event); v_target uuid;
begin
  select id into v_target from auth.users where lower(email) = lower(btrim(p_email));
  if v_target is null or not (private.user_has_role(v_target, 'organiser') or private.user_has_role(v_target, 'admin')) then
    raise exception 'organiser_not_found' using errcode = 'P0002';
  end if;
  insert into public.event_organisers (event_id, user_id, role) values (p_event, v_target, 'co_organiser') on conflict do nothing;
  perform private.audit(p_event, 'event.co_organiser_added', 'user', v_target::text);
end $$;

create or replace function public.remove_co_organiser(p_event uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event);
begin
  delete from public.event_organisers where event_id = p_event and user_id = p_user and role = 'co_organiser';
  perform private.audit(p_event, 'event.co_organiser_removed', 'user', p_user::text);
end $$;

-- ---------------------------------------------------------------------------
-- Organiser reads
-- ---------------------------------------------------------------------------
create or replace function public.organiser_events() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'slug', e.slug, 'name', e.name, 'status', e.status, 'is_paused', e.is_paused,
      'starts_at', e.starts_at, 'timezone', e.timezone, 'venue_name', e.venue_name, 'role', o.role,
      'registered', (select count(*) from public.event_registrations r where r.event_id = e.id and r.status in ('registered', 'checked_in'))
    ) order by e.created_at desc), '[]'::jsonb)
  from public.events e join public.event_organisers o on o.event_id = e.id and o.user_id = auth.uid()
$$;

create or replace function public.organiser_event_detail(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event); e public.events;
begin
  select * into e from public.events where id = p_event;
  return jsonb_build_object(
    'event', to_jsonb(e),
    'server_now', now(),
    'counts', private.event_counts(p_event),
    'organisers', (select coalesce(jsonb_agg(jsonb_build_object('user_id', o.user_id, 'role', o.role, 'full_name', p.full_name,
                     'email', u.email)), '[]'::jsonb)
                   from public.event_organisers o join auth.users u on u.id = o.user_id left join public.profiles p on p.id = o.user_id
                   where o.event_id = p_event),
    'rounds', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'round_number', r.round_number, 'mode', r.mode,
                 'status', r.status, 'eligible_count', r.eligible_count, 'matched_pairs', r.matched_pairs,
                 'unmatched_count', r.unmatched_count, 'algorithm', r.algorithm, 'error', r.error,
                 'started_at', r.started_at, 'completed_at', r.completed_at) order by r.round_number desc), '[]'::jsonb)
               from public.match_rounds r where r.event_id = p_event),
    'primary_revealed', private.primary_revealed(p_event),
    'recommendations_revealed', private.recommendations_revealed(p_event),
    'recommendation_count', (select count(*) from public.recommendations where event_id = p_event)
  );
end $$;

-- Organisers see professional basics needed to run the event; never contact
-- details, resumes, follow-up decisions or connection requests.
create or replace function public.organiser_event_attendees(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', r.user_id, 'full_name', p.full_name, 'job_title', p.job_title, 'organisation', p.organisation,
      'industry', p.industry, 'status', r.status, 'matching_consent', r.matching_consent,
      'recommendations_opt_in', r.recommendations_opt_in, 'profile_complete', p.profile_completed_at is not null,
      'suspended', p.suspended_at is not null, 'is_late', r.is_late, 'registered_at', r.registered_at,
      'checked_in_at', r.checked_in_at, 'awaiting_match', r.awaiting_match_since is not null,
      'matched', exists (select 1 from public.match_round_members m where m.event_id = p_event and m.user_id = r.user_id and m.assignment_active)
    ) order by r.registered_at), '[]'::jsonb)
    from public.event_registrations r join public.profiles p on p.id = r.user_id
    where r.event_id = p_event);
end $$;

create or replace function public.organiser_manage_registration(p_event uuid, p_user uuid, p_action text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event); r public.event_registrations;
begin
  select * into r from public.event_registrations where event_id = p_event and user_id = p_user for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  case p_action
    when 'check_in' then
      if r.status <> 'registered' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
      update public.event_registrations set status = 'checked_in', checked_in_at = now() where id = r.id;
    when 'undo_check_in' then
      if r.status <> 'checked_in' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
      update public.event_registrations set status = 'registered', checked_in_at = null where id = r.id;
    when 'remove' then
      if r.status = 'removed' then return; end if;
      perform private.withdraw_user(p_event, p_user, 'removed', coalesce(p_reason, 'Removed by organiser'));
    when 'restore' then
      if r.status <> 'removed' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
      update public.event_registrations set status = 'registered', removed_reason = null,
        awaiting_match_since = case when matching_consent then now() end where id = r.id;
    else raise exception 'invalid_input:action' using errcode = '22023';
  end case;
  perform private.audit(p_event, 'registration.' || p_action, 'user', p_user::text, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.organiser_round_assignments(p_round uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_event uuid; v_uid uuid;
begin
  select event_id into v_event from public.match_rounds where id = p_round;
  if v_event is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_uid := private.require_organiser(v_event);
  return jsonb_build_object(
    'assignments', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'score', a.score, 'status', a.status, 'cancel_reason', a.cancel_reason, 'breakdown', a.breakdown,
        'reasons', a.reasons -> 'a',
        'user_a', jsonb_build_object('id', a.user_a, 'full_name', pa.full_name, 'job_title', pa.job_title, 'organisation', pa.organisation),
        'user_b', jsonb_build_object('id', a.user_b, 'full_name', pb.full_name, 'job_title', pb.job_title, 'organisation', pb.organisation)
      ) order by a.score desc), '[]'::jsonb)
      from public.match_assignments a left join public.profiles pa on pa.id = a.user_a left join public.profiles pb on pb.id = a.user_b
      where a.round_id = p_round),
    'unmatched', (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'full_name', p.full_name, 'job_title', p.job_title)), '[]'::jsonb)
      from public.match_round_members m join public.profiles p on p.id = m.user_id
      where m.round_id = p_round and m.assignment_id is null)
  );
end $$;

create or replace function public.organiser_cancel_assignment(p_assignment uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_event uuid; v_uid uuid;
begin
  select event_id into v_event from public.match_assignments where id = p_assignment;
  if v_event is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_uid := private.require_organiser(v_event);
  perform private.cancel_assignment(p_assignment, 'organiser', null);
  perform private.audit(v_event, 'assignment.cancelled', 'assignment', p_assignment::text, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.event_analytics(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event); v_followups jsonb; v_n int;
begin
  select count(*) into v_n from public.match_followups f join public.match_assignments a on a.id = f.assignment_id where a.event_id = p_event;
  -- Aggregate follow-up choices only once there are enough to avoid
  -- identifying individual decisions.
  if v_n >= 5 then
    select jsonb_object_agg(choice, n) into v_followups from (
      select f.choice, count(*) n from public.match_followups f join public.match_assignments a on a.id = f.assignment_id
      where a.event_id = p_event group by f.choice) x;
  end if;
  return jsonb_build_object(
    'counts', private.event_counts(p_event),
    'feedback', (select jsonb_build_object('responses', count(*), 'avg_match_rating', round(avg(rating), 2),
                  'met_in_person_rate', round(avg(case when met_in_person then 1 else 0 end), 2),
                  'avg_event_rating', round(avg(event_rating), 2))
                 from public.match_feedback where event_id = p_event),
    'recent_comments', (select coalesce(jsonb_agg(c), '[]'::jsonb) from (
                          select comment as c from public.match_feedback where event_id = p_event and comment is not null
                          order by created_at desc limit 20) x),
    'followups', coalesce(v_followups, '{}'::jsonb),
    'followup_responses', v_n,
    'connections_made', (select count(distinct (user_a, user_b)) from public.connections where event_id = p_event),
    'mentorships_made', (select count(*) from public.connections where event_id = p_event and kind = 'mentorship'),
    'requests_sent', (select count(*) from public.connection_requests where event_id = p_event),
    'requests_accepted', (select count(*) from public.connection_requests where event_id = p_event and status = 'accepted'),
    'profiles_saved', (select count(*) from public.saved_profiles where event_id = p_event),
    'avg_match_score', (select round(avg(score), 1) from public.match_assignments where event_id = p_event and status = 'active'),
    'industries', (select coalesce(jsonb_object_agg(industry, n), '{}'::jsonb) from (
                     select coalesce(p.industry, 'unspecified') industry, count(*) n from public.event_registrations r
                     join public.profiles p on p.id = r.user_id
                     where r.event_id = p_event and r.status in ('registered', 'checked_in') group by 1) x),
    'goals', (select coalesce(jsonb_object_agg(goal, n), '{}'::jsonb) from (
                     select g goal, count(*) n from public.event_registrations r join public.profiles p on p.id = r.user_id,
                     unnest(p.career_goals) g where r.event_id = p_event and r.status in ('registered', 'checked_in') group by 1) x)
  );
end $$;

create or replace function public.event_audit_log(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_organiser(p_event);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'action', l.action, 'actor', p.full_name,
            'target_type', l.target_type, 'details', l.details, 'created_at', l.created_at) order by l.created_at desc), '[]'::jsonb)
          from (select * from public.audit_logs where event_id = p_event order by created_at desc limit 200) l
          left join public.profiles p on p.id = l.actor_id);
end $$;

-- ---------------------------------------------------------------------------
-- Matching job interface (service_role only; called by edge functions).
-- ---------------------------------------------------------------------------
create or replace function private.matching_features(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'first_name', split_part(coalesce(p.full_name, ''), ' ', 1),
    'organisation', lower(btrim(p.organisation)), 'role_category', p.role_category, 'industry', p.industry,
    'employment_status', p.employment_status, 'career_stage', p.career_stage, 'work_environment', p.work_environment,
    'career_goals', to_jsonb(p.career_goals), 'target_roles', to_jsonb(p.target_roles),
    'target_industries', to_jsonb(p.target_industries), 'skills', to_jsonb(p.skills),
    'professional_interests', to_jsonb(p.professional_interests), 'mentorship_preference', p.mentorship_preference,
    'hobbies', to_jsonb(p.hobbies), 'city', p.city, 'country', p.country,
    'match_visible_fields', to_jsonb(s.match_visible_fields),
    'recommendation_visible_fields', to_jsonb(s.recommendation_visible_fields)
  )
  from public.profiles p join public.privacy_settings s on s.user_id = p.id
  where p.id = p_user
$$;

-- Eligible pool. 'supplemental' = eligible attendees without an active match.
create or replace function private.matching_pool(p_event uuid, p_mode public.match_round_mode) returns setof uuid
language sql stable security definer set search_path = public as $$
  select r.user_id from public.event_registrations r join public.profiles p on p.id = r.user_id
  where r.event_id = p_event and r.status in ('registered', 'checked_in') and r.matching_consent
    and p.profile_completed_at is not null and p.suspended_at is null
    and (p_mode = 'primary' or not exists (
      select 1 from public.match_round_members m where m.event_id = p_event and m.user_id = r.user_id and m.assignment_active))
  order by r.user_id
$$;

create or replace function private.pool_snapshot(p_event uuid, p_users uuid[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'members', coalesce((select jsonb_agg(private.matching_features(u) order by u) from unnest(p_users) u), '[]'::jsonb),
    'blocked_pairs', coalesce((select jsonb_agg(jsonb_build_array(b.blocker_id, b.blocked_id)) from public.blocks b
                      where b.blocker_id = any(p_users) and b.blocked_id = any(p_users)), '[]'::jsonb),
    -- Never re-pair two people whose earlier assignment was cancelled.
    'excluded_pairs', coalesce((select jsonb_agg(jsonb_build_array(a.user_a, a.user_b)) from public.match_assignments a
                      where a.event_id = p_event and a.status = 'cancelled' and a.user_a = any(p_users) and a.user_b = any(p_users)), '[]'::jsonb)
  )
$$;

create or replace function public.service_matching_preview(p_event uuid, p_mode public.match_round_mode default 'primary') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e public.events; v_users uuid[];
begin
  select * into e from public.events where id = p_event;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select coalesce(array_agg(u), '{}') into v_users from private.matching_pool(p_event, p_mode) u;
  return jsonb_build_object('event_id', p_event, 'mode', p_mode, 'weights', e.matching_weights, 'rules', e.role_rules)
    || private.pool_snapshot(p_event, v_users);
end $$;

-- Start (or resume) a matching round. Idempotent:
--  * same idempotency key -> same round
--  * a fresh running round -> returned as-is (no second concurrent job)
--  * a stale running round -> marked failed, new round created
--  * a completed primary round -> requires p_confirm_rerun and must be before reveal
create or replace function public.service_begin_match_round(
  p_event uuid, p_mode public.match_round_mode, p_actor uuid default null,
  p_confirm_rerun boolean default false, p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.events; r public.match_rounds; v_users uuid[]; v_num int;
begin
  select * into e from public.events where id = p_event for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if e.is_paused then raise exception 'event_paused' using errcode = 'P0001'; end if;

  if p_idempotency_key is not null then
    select * into r from public.match_rounds where event_id = p_event and idempotency_key = p_idempotency_key;
    if found then return jsonb_build_object('round_id', r.id, 'status', r.status, 'reused', true); end if;
  end if;

  select * into r from public.match_rounds where event_id = p_event and status = 'running';
  if found then
    if r.started_at > now() - interval '10 minutes' then
      return jsonb_build_object('round_id', r.id, 'status', r.status, 'reused', true, 'already_running', true);
    end if;
    update public.match_rounds set status = 'failed', error = 'stale: job did not complete', completed_at = now() where id = r.id;
  end if;

  if p_mode = 'primary' then
    if e.status in ('draft', 'archived', 'event_ended', 'recommendations_available') then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if e.status = 'registration_open' and now() < e.registration_deadline then
      raise exception 'registration_still_open' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.match_rounds where event_id = p_event and mode = 'primary' and status = 'completed') then
      if not p_confirm_rerun then raise exception 'confirmation_required' using errcode = 'P0001', hint = 'rerun'; end if;
      if private.primary_revealed(p_event) then raise exception 'rerun_after_reveal' using errcode = 'P0001'; end if;
    end if;
  else
    if not exists (select 1 from public.match_rounds where event_id = p_event and mode = 'primary' and status = 'completed') then
      raise exception 'primary_round_required' using errcode = 'P0001';
    end if;
    if e.status not in ('primary_ready', 'primary_revealed') or (e.ends_at is not null and now() >= e.ends_at) then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
  end if;

  select coalesce(array_agg(u), '{}') into v_users from private.matching_pool(p_event, p_mode) u;
  if p_mode = 'supplemental' and cardinality(v_users) < 2 then
    update public.event_registrations set awaiting_match_since = null where event_id = p_event and user_id = any(v_users);
    return jsonb_build_object('skipped', true, 'reason', 'insufficient_pool', 'eligible_count', cardinality(v_users));
  end if;

  select coalesce(max(round_number), 0) + 1 into v_num from public.match_rounds where event_id = p_event;
  insert into public.match_rounds (event_id, round_number, mode, status, idempotency_key, weights, rules, eligible_count, started_by)
  values (p_event, v_num, p_mode, 'running', p_idempotency_key, e.matching_weights, e.role_rules, cardinality(v_users), p_actor)
  returning * into r;
  insert into public.match_round_members (round_id, event_id, user_id)
  select r.id, p_event, u from unnest(v_users) u;

  if p_mode = 'primary' then
    update public.events set status = 'matching_in_progress' where id = p_event;
  end if;
  insert into public.audit_logs (actor_id, event_id, action, target_type, target_id, details)
  values (p_actor, p_event, 'matching.started', 'match_round', r.id::text,
          jsonb_build_object('mode', p_mode, 'round_number', v_num, 'eligible', cardinality(v_users)));
  return jsonb_build_object('round_id', r.id, 'status', r.status, 'reused', false);
end $$;

-- The pool is frozen when the round begins, so a retry sees identical input.
create or replace function public.service_round_snapshot(p_round uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.match_rounds; v_users uuid[];
begin
  select * into r from public.match_rounds where id = p_round;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select coalesce(array_agg(user_id order by user_id), '{}') into v_users from public.match_round_members where round_id = p_round;
  return jsonb_build_object('round_id', r.id, 'event_id', r.event_id, 'mode', r.mode, 'status', r.status,
    'weights', r.weights, 'rules', r.rules) || private.pool_snapshot(r.event_id, v_users);
end $$;

-- Atomically persist a round's assignments. Re-validates every constraint so
-- a buggy or malicious caller cannot create invalid matches.
create or replace function public.service_commit_match_round(p_round uuid, p_pairs jsonb, p_algorithm text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.match_rounds; e public.events; x jsonb; v_a uuid; v_b uuid; v_swap boolean; v_seen uuid[] := '{}';
  v_id uuid; v_pairs int := 0; v_user uuid; v_revealed boolean; v_prev uuid[];
begin
  select * into r from public.match_rounds where id = p_round for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status = 'completed' then
    return jsonb_build_object('round_id', r.id, 'status', 'completed', 'already_completed', true, 'matched_pairs', r.matched_pairs);
  end if;
  if r.status <> 'running' then raise exception 'round_not_running' using errcode = 'P0001'; end if;
  select * into e from public.events where id = r.event_id for update;

  if jsonb_typeof(p_pairs) <> 'array' then raise exception 'invalid_input:pairs' using errcode = '22023'; end if;

  -- Rerun of the primary round replaces previous (unrevealed) assignments.
  if r.mode = 'primary' then
    select coalesce(array_agg(id), '{}') into v_prev from public.match_rounds
     where event_id = r.event_id and status = 'completed' and id <> r.id;
    if cardinality(v_prev) > 0 then
      update public.match_rounds set status = 'superseded' where id = any(v_prev);
      update public.match_assignments set status = 'superseded' where round_id = any(v_prev) and status = 'active';
      update public.match_round_members set assignment_active = false where round_id = any(v_prev);
    end if;
  end if;

  for x in select * from jsonb_array_elements(p_pairs) loop
    v_a := (x ->> 'a')::uuid; v_b := (x ->> 'b')::uuid;
    if v_a is null or v_b is null or v_a = v_b then raise exception 'invalid_input:pair' using errcode = '22023'; end if;
    if v_a = any(v_seen) or v_b = any(v_seen) then raise exception 'invalid_input:duplicate_user' using errcode = '22023'; end if;
    v_seen := v_seen || v_a || v_b;
    if (select count(*) from public.match_round_members where round_id = r.id and user_id in (v_a, v_b)) <> 2 then
      raise exception 'invalid_input:not_in_pool' using errcode = '22023';
    end if;
    if cardinality(private.match_ineligibility(r.event_id, v_a)) > 0 or cardinality(private.match_ineligibility(r.event_id, v_b)) > 0 then
      raise exception 'invalid_input:ineligible_user' using errcode = '22023';
    end if;
    if private.is_blocked(v_a, v_b) then raise exception 'invalid_input:blocked_pair' using errcode = '22023'; end if;
    if (x ->> 'score')::numeric is null or (x ->> 'score')::numeric not between 0 and 100 then
      raise exception 'invalid_input:score' using errcode = '22023';
    end if;

    v_swap := v_a > v_b;
    insert into public.match_assignments (round_id, event_id, user_a, user_b, score, breakdown, reasons, starters)
    values (r.id, r.event_id, least(v_a, v_b), greatest(v_a, v_b), round((x ->> 'score')::numeric, 2),
      coalesce(x -> 'breakdown', '{}'::jsonb),
      case when v_swap then jsonb_build_object('a', coalesce(x -> 'reasons_b', '[]'), 'b', coalesce(x -> 'reasons_a', '[]'))
           else jsonb_build_object('a', coalesce(x -> 'reasons_a', '[]'), 'b', coalesce(x -> 'reasons_b', '[]')) end,
      case when v_swap then jsonb_build_object('a', x -> 'starter_b', 'b', x -> 'starter_a')
           else jsonb_build_object('a', x -> 'starter_a', 'b', x -> 'starter_b') end)
    returning id into v_id;
    -- The partial unique index rejects anyone who already holds an active match.
    update public.match_round_members set assignment_id = v_id, assignment_active = true
     where round_id = r.id and user_id in (v_a, v_b);
    v_pairs := v_pairs + 1;
  end loop;

  update public.match_rounds set status = 'completed', completed_at = now(), algorithm = left(p_algorithm, 100),
    matched_pairs = v_pairs, unmatched_count = eligible_count - 2 * v_pairs, error = null
  where id = r.id;
  update public.event_registrations set awaiting_match_since = null
   where event_id = r.event_id and user_id in (select user_id from public.match_round_members where round_id = r.id);

  v_revealed := e.primary_reveal_at <= now();
  if r.mode = 'primary' then
    update public.events set auto_match_failures = 0,
      status = case when e.status = 'matching_in_progress' then
                 (case when v_revealed then 'primary_revealed' else 'primary_ready' end)::public.event_status
               else e.status end
    where id = e.id;
  elsif v_revealed and not e.is_paused then
    for v_user in select user_id from public.match_round_members where round_id = r.id and assignment_id is not null loop
      perform private.notify(v_user, 'match_ready', 'You have a new match at ' || e.name,
        'We found someone for you to meet.', '/e/' || e.slug || '/match');
    end loop;
  end if;

  insert into public.audit_logs (actor_id, event_id, action, target_type, target_id, details)
  values (r.started_by, r.event_id, 'matching.completed', 'match_round', r.id::text,
          jsonb_build_object('pairs', v_pairs, 'eligible', r.eligible_count, 'algorithm', p_algorithm));
  return jsonb_build_object('round_id', r.id, 'status', 'completed', 'matched_pairs', v_pairs,
                            'unmatched', r.eligible_count - 2 * v_pairs);
end $$;

create or replace function public.service_fail_match_round(p_round uuid, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.match_rounds; e public.events; v_org uuid;
begin
  select * into r from public.match_rounds where id = p_round for update;
  if not found or r.status <> 'running' then return; end if;
  update public.match_rounds set status = 'failed', error = left(p_error, 1000), completed_at = now() where id = r.id;
  select * into e from public.events where id = r.event_id for update;
  if e.status = 'matching_in_progress' then
    update public.events set status = case
      when exists (select 1 from public.match_rounds where event_id = e.id and status = 'completed')
        then (case when e.primary_reveal_at <= now() then 'primary_revealed' else 'primary_ready' end)::public.event_status
      else 'registration_closed'::public.event_status end
    where id = e.id;
  end if;
  update public.events set auto_match_failures = auto_match_failures + 1 where id = e.id;
  for v_org in select user_id from public.event_organisers where event_id = e.id loop
    perform private.notify(v_org, 'matching_failed', 'Matching needs attention: ' || e.name,
      'A matching job failed. You can safely retry from the dashboard.', '/organiser/events/' || e.id);
  end loop;
  insert into public.audit_logs (actor_id, event_id, action, target_type, target_id, details)
  values (r.started_by, r.event_id, 'matching.failed', 'match_round', r.id::text, jsonb_build_object('error', left(p_error, 500)));
end $$;

-- ---------------------------------------------------------------------------
-- Recommendations job interface (service_role only)
-- ---------------------------------------------------------------------------
create or replace function private.recommendation_pool(p_event uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select r.user_id from public.event_registrations r join public.profiles p on p.id = r.user_id
  where r.event_id = p_event and r.status in ('registered', 'checked_in') and r.recommendations_opt_in
    and p.profile_completed_at is not null and p.suspended_at is null
  order by r.user_id
$$;

create or replace function public.service_recommendation_snapshot(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e public.events; v_users uuid[];
begin
  select * into e from public.events where id = p_event;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select coalesce(array_agg(u), '{}') into v_users from private.recommendation_pool(p_event) u;
  return jsonb_build_object('event_id', p_event, 'weights', e.matching_weights, 'rules', e.role_rules)
    || private.pool_snapshot(p_event, v_users)
    || jsonb_build_object(
      -- The primary match (current or past) is never re-recommended.
      'primary_pairs', coalesce((select jsonb_agg(jsonb_build_array(a.user_a, a.user_b)) from public.match_assignments a
                         where a.event_id = p_event and a.status in ('active', 'cancelled')), '[]'::jsonb),
      'connected_pairs', coalesce((select jsonb_agg(distinct jsonb_build_array(c.user_a, c.user_b)) from public.connections c
                         where c.user_a = any(v_users) and c.user_b = any(v_users)), '[]'::jsonb));
end $$;

create or replace function public.service_commit_recommendations(p_event uuid, p_recs jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e public.events; x jsonb; v_u uuid; v_r uuid; v_n int := 0; v_pool uuid[];
begin
  select * into e from public.events where id = p_event for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_recs) <> 'array' then raise exception 'invalid_input:recs' using errcode = '22023'; end if;
  select coalesce(array_agg(u), '{}') into v_pool from private.recommendation_pool(p_event) u;

  delete from public.recommendations where event_id = p_event;
  for x in select * from jsonb_array_elements(p_recs) loop
    v_u := (x ->> 'user_id')::uuid; v_r := (x ->> 'recommended_user_id')::uuid;
    if not (v_u = any(v_pool) and v_r = any(v_pool)) then raise exception 'invalid_input:not_in_pool' using errcode = '22023'; end if;
    if private.is_blocked(v_u, v_r) then raise exception 'invalid_input:blocked_pair' using errcode = '22023'; end if;
    if exists (select 1 from public.match_assignments a where a.event_id = p_event and a.status in ('active', 'cancelled')
               and a.user_a = least(v_u, v_r) and a.user_b = greatest(v_u, v_r)) then
      raise exception 'invalid_input:primary_pair' using errcode = '22023';
    end if;
    insert into public.recommendations (event_id, user_id, recommended_user_id, rank, score, reasons)
    values (p_event, v_u, v_r, (x ->> 'rank')::int, round((x ->> 'score')::numeric, 2),
            coalesce((select array_agg(t) from jsonb_array_elements_text(x -> 'reasons') t), '{}'));
    v_n := v_n + 1;
  end loop;
  update public.events set recommendations_generated_at = now() where id = p_event;
  insert into public.audit_logs (event_id, action, target_type, target_id, details)
  values (p_event, 'recommendations.generated', 'event', p_event::text, jsonb_build_object('count', v_n));
  return jsonb_build_object('count', v_n);
end $$;
