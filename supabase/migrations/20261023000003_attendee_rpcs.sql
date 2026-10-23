-- Attendee-facing RPCs. Every function derives the caller from auth.uid(),
-- applies consent/visibility rules and uses the server clock for reveals.

-- ---------------------------------------------------------------------------
-- Shared internals
-- ---------------------------------------------------------------------------
create or replace function private.event_public_json(e public.events) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', e.id, 'slug', e.slug, 'name', e.name, 'tagline', e.tagline, 'description', e.description,
    'venue_name', e.venue_name, 'venue_address', e.venue_address, 'timezone', e.timezone,
    'accent_color', e.accent_color, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
    'registration_opens_at', e.registration_opens_at, 'registration_deadline', e.registration_deadline,
    'primary_reveal_at', e.primary_reveal_at, 'post_event_reveal_at', e.post_event_reveal_at,
    'status', e.status, 'is_paused', e.is_paused, 'requires_access_code', e.access_code is not null,
    'allow_late_registration', e.allow_late_registration, 'has_capacity_limit', e.capacity is not null
  )
$$;

-- 'not_open' | 'open' | 'late' | 'closed' | 'paused'
create or replace function private.registration_window(e public.events) returns text
language sql stable as $$
  select case
    when e.status in ('draft', 'archived') then 'closed'
    when e.is_paused then 'paused'
    when e.ends_at is not null and now() >= e.ends_at then 'closed'
    when e.status = 'registration_open' and (e.registration_opens_at is null or now() >= e.registration_opens_at)
         and (e.registration_deadline is null or now() < e.registration_deadline) then 'open'
    when e.status = 'registration_open' and e.registration_opens_at is not null and now() < e.registration_opens_at then 'not_open'
    when e.allow_late_registration
         and e.status in ('registration_open', 'registration_closed', 'matching_in_progress', 'primary_ready', 'primary_revealed')
         then 'late'
    else 'closed'
  end
$$;

-- Reasons a registered attendee would be excluded from matching.
create or replace function private.match_ineligibility(p_event uuid, p_user uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare r public.event_registrations; p public.profiles; v text[] := '{}';
begin
  select * into r from public.event_registrations where event_id = p_event and user_id = p_user;
  if not found then return array['not_registered']; end if;
  select * into p from public.profiles where id = p_user;
  if r.status not in ('registered', 'checked_in') then v := array_append(v, 'not_active'); end if;
  if not r.matching_consent then v := array_append(v, 'no_consent'); end if;
  if p.profile_completed_at is null then v := array_append(v, 'profile_incomplete'); end if;
  if p.suspended_at is not null then v := array_append(v, 'suspended'); end if;
  return v;
end $$;

-- Cancel a primary assignment without telling either side why.
create or replace function private.cancel_assignment(p_assignment uuid, p_reason text, p_initiator uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a public.match_assignments; e public.events; v_partner uuid;
begin
  select * into a from public.match_assignments where id = p_assignment for update;
  if not found or a.status <> 'active' then return; end if;
  select * into e from public.events where id = a.event_id;

  update public.match_assignments set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   where id = a.id;
  update public.match_round_members set assignment_active = false where assignment_id = a.id;

  foreach v_partner in array array[a.user_a, a.user_b] loop
    continue when v_partner is null or v_partner = p_initiator;
    -- The partner becomes eligible for a late/supplemental round if the
    -- event is still running.
    if e.ends_at is null or now() < e.ends_at then
      update public.event_registrations set awaiting_match_since = now()
       where event_id = a.event_id and user_id = v_partner and status in ('registered', 'checked_in') and matching_consent;
    end if;
    if private.primary_revealed(a.event_id) and p_reason <> 'blocked' then
      perform private.notify(v_partner, 'match_unavailable', 'Your match can no longer meet',
        'Something came up for your match. We''ll try to introduce you to someone else if we can.',
        '/e/' || e.slug || '/match');
    end if;
  end loop;
end $$;

create or replace function private.active_assignment_for(p_event uuid, p_user uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select m.assignment_id from public.match_round_members m
  where m.event_id = p_event and m.user_id = p_user and m.assignment_active
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Event entry & registration
-- ---------------------------------------------------------------------------
create or replace function public.get_event_public(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e public.events; r public.event_registrations; v_uid uuid := auth.uid(); v_full boolean := false;
begin
  select * into e from public.events where slug = lower(p_slug) and status <> 'draft';
  if not found then
    -- Organisers may preview their own drafts.
    select * into e from public.events where slug = lower(p_slug);
    if not found or not private.is_event_organiser(e.id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  if e.capacity is not null then
    select count(*) >= e.capacity into v_full from public.event_registrations
     where event_id = e.id and status in ('registered', 'checked_in');
  end if;
  if v_uid is not null then
    select * into r from public.event_registrations where event_id = e.id and user_id = v_uid;
  end if;
  return jsonb_build_object(
    'event', private.event_public_json(e) || jsonb_build_object('is_full', v_full),
    'registration_window', private.registration_window(e),
    'server_now', now(),
    'is_organiser', private.is_event_organiser(e.id),
    'registration', case when r.id is null then null else jsonb_build_object(
      'status', r.status, 'matching_consent', r.matching_consent,
      'recommendations_opt_in', r.recommendations_opt_in, 'is_late', r.is_late,
      'registered_at', r.registered_at) end
  );
end $$;

create or replace function public.register_for_event(
  p_slug text, p_matching_consent boolean, p_recommendations_opt_in boolean,
  p_access_code text default null, p_consent_version text default '2026-10-01'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := private.require_auth();
  e public.events; r public.event_registrations; v_window text; v_email text; v_domain text; v_count int;
  v_late boolean;
begin
  if p_matching_consent is null or p_recommendations_opt_in is null then
    raise exception 'invalid_input:consent_required' using errcode = '22023';
  end if;
  -- Rejections below are returned (not raised) so the attempt stays counted
  -- by the rate limiter: access codes cannot be brute-forced.
  perform private.enforce_rate_limit('register', 10, interval '10 minutes');

  select * into e from public.events where slug = lower(p_slug) for update;
  if not found or e.status = 'draft' then raise exception 'not_found' using errcode = 'P0002'; end if;

  if exists (select 1 from public.profiles where id = v_uid and suspended_at is not null) then
    raise exception 'account_suspended' using errcode = '42501';
  end if;

  select * into r from public.event_registrations where event_id = e.id and user_id = v_uid;
  if found and r.status = 'removed' then
    raise exception 'removed_by_organiser' using errcode = '42501';
  end if;

  -- Existing active registration: just update consent choices.
  if found and r.status in ('registered', 'checked_in') then
    return public.update_my_registration(e.id, p_matching_consent, p_recommendations_opt_in);
  end if;

  v_window := private.registration_window(e);
  if v_window not in ('open', 'late') then
    return jsonb_build_object('error', 'registration_closed', 'detail', v_window);
  end if;

  if e.access_code is not null and (p_access_code is null or p_access_code <> e.access_code) then
    return jsonb_build_object('error', 'invalid_access_code');
  end if;

  if coalesce(array_length(e.allowed_email_domains, 1), 0) > 0 then
    select lower(email) into v_email from auth.users where id = v_uid;
    v_domain := split_part(coalesce(v_email, ''), '@', 2);
    if not exists (select 1 from unnest(e.allowed_email_domains) d where lower(d) = v_domain) then
      return jsonb_build_object('error', 'email_domain_not_allowed');
    end if;
  end if;

  if e.capacity is not null then
    select count(*) into v_count from public.event_registrations
     where event_id = e.id and status in ('registered', 'checked_in');
    if v_count >= e.capacity then return jsonb_build_object('error', 'event_full'); end if;
  end if;

  -- Late = after the main matching pool was fixed.
  v_late := v_window = 'late' or exists (
    select 1 from public.match_rounds where event_id = e.id and mode = 'primary' and status in ('running', 'completed'));

  insert into public.event_registrations as er (event_id, user_id, status, matching_consent, recommendations_opt_in,
    consent_version, consented_at, is_late, awaiting_match_since, registered_at)
  values (e.id, v_uid, 'registered', p_matching_consent, p_recommendations_opt_in,
    left(p_consent_version, 40), now(), v_late, case when v_late and p_matching_consent then now() end, now())
  on conflict (event_id, user_id) do update set
    status = 'registered', matching_consent = excluded.matching_consent,
    recommendations_opt_in = excluded.recommendations_opt_in, consent_version = excluded.consent_version,
    consented_at = now(), is_late = excluded.is_late, awaiting_match_since = excluded.awaiting_match_since,
    withdrawn_at = null
  returning * into r;

  return jsonb_build_object('status', r.status, 'matching_consent', r.matching_consent,
    'recommendations_opt_in', r.recommendations_opt_in, 'is_late', r.is_late, 'event_id', e.id);
end $$;

create or replace function public.update_my_registration(p_event uuid, p_matching_consent boolean, p_recommendations_opt_in boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); r public.event_registrations; v_assignment uuid; v_primary_done boolean;
begin
  select * into r from public.event_registrations where event_id = p_event and user_id = v_uid for update;
  if not found or r.status not in ('registered', 'checked_in') then
    raise exception 'not_registered' using errcode = 'P0002';
  end if;

  if r.matching_consent and not p_matching_consent then
    v_assignment := private.active_assignment_for(p_event, v_uid);
    if v_assignment is not null then
      perform private.cancel_assignment(v_assignment, 'consent_revoked', v_uid);
    end if;
  end if;

  select exists (select 1 from public.match_rounds where event_id = p_event and mode = 'primary' and status = 'completed')
    into v_primary_done;

  update public.event_registrations set
    matching_consent = p_matching_consent,
    recommendations_opt_in = p_recommendations_opt_in,
    consented_at = now(),
    awaiting_match_since = case
      when not p_matching_consent then null
      when not r.matching_consent and p_matching_consent and v_primary_done then now()
      else awaiting_match_since end
  where id = r.id returning * into r;

  if not p_recommendations_opt_in then
    delete from public.recommendations where event_id = p_event and (user_id = v_uid or recommended_user_id = v_uid);
  end if;

  return jsonb_build_object('status', r.status, 'matching_consent', r.matching_consent,
    'recommendations_opt_in', r.recommendations_opt_in, 'is_late', r.is_late, 'event_id', p_event);
end $$;

create or replace function private.withdraw_user(p_event uuid, p_user uuid, p_status public.registration_status, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_assignment uuid;
begin
  v_assignment := private.active_assignment_for(p_event, p_user);
  if v_assignment is not null then
    perform private.cancel_assignment(v_assignment,
      case when p_status = 'removed' then 'removed' when p_reason = 'account_deleted' then 'account_deleted' else 'withdrawal' end,
      p_user);
  end if;
  update public.event_registrations set status = p_status,
    withdrawn_at = case when p_status = 'withdrawn' then now() else withdrawn_at end,
    removed_reason = case when p_status = 'removed' then left(p_reason, 300) else removed_reason end,
    awaiting_match_since = null
  where event_id = p_event and user_id = p_user;
  delete from public.recommendations where event_id = p_event and (user_id = p_user or recommended_user_id = p_user);
end $$;

create or replace function public.withdraw_from_event(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth();
begin
  if not exists (select 1 from public.event_registrations where event_id = p_event and user_id = v_uid
                 and status in ('registered', 'checked_in')) then
    raise exception 'not_registered' using errcode = 'P0002';
  end if;
  perform private.withdraw_user(p_event, v_uid, 'withdrawn', null);
end $$;

create or replace function public.my_events() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(private.event_public_json(e) || jsonb_build_object(
    'registration_status', r.status, 'matching_consent', r.matching_consent,
    'recommendations_opt_in', r.recommendations_opt_in) order by e.starts_at desc nulls last), '[]'::jsonb)
  from public.event_registrations r join public.events e on e.id = r.event_id
  where r.user_id = auth.uid() and e.status <> 'draft'
$$;

-- Waiting room / event hub. All gating decisions come from the server.
create or replace function public.get_event_hub(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); e public.events; r public.event_registrations; p public.profiles;
begin
  select * into e from public.events where id = p_event and status <> 'draft';
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into r from public.event_registrations where event_id = p_event and user_id = v_uid;
  if not found then raise exception 'not_registered' using errcode = 'P0002'; end if;
  select * into p from public.profiles where id = v_uid;
  return jsonb_build_object(
    'event', private.event_public_json(e),
    'server_now', now(),
    'registration', jsonb_build_object('status', r.status, 'matching_consent', r.matching_consent,
      'recommendations_opt_in', r.recommendations_opt_in, 'is_late', r.is_late, 'registered_at', r.registered_at),
    'profile_complete', p.profile_completed_at is not null,
    'ineligible_reasons', to_jsonb(private.match_ineligibility(p_event, v_uid)),
    'primary_revealed', private.primary_revealed(p_event),
    'recommendations_revealed', private.recommendations_revealed(p_event)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Primary match (reveal-gated)
-- ---------------------------------------------------------------------------
create or replace function public.get_my_primary_match(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := private.require_auth();
  e public.events; r public.event_registrations; m record; a public.match_assignments;
  v_side text; v_partner uuid; v_base jsonb; v_choice public.followup_choice; v_outcome text;
begin
  select * into e from public.events where id = p_event and status <> 'draft';
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  v_base := jsonb_build_object('server_now', now(), 'reveal_at', e.primary_reveal_at, 'event_slug', e.slug);

  select * into r from public.event_registrations where event_id = p_event and user_id = v_uid;
  if not found then return v_base || jsonb_build_object('state', 'not_registered'); end if;
  if r.status in ('withdrawn', 'removed') then return v_base || jsonb_build_object('state', 'withdrawn'); end if;

  -- Nothing about matching leaks before the server-authorised reveal.
  if not private.primary_revealed(p_event) then
    return v_base || jsonb_build_object('state', 'waiting', 'paused', e.is_paused);
  end if;

  select mm.*, rr.round_number into m
  from public.match_round_members mm join public.match_rounds rr on rr.id = mm.round_id
  where mm.event_id = p_event and mm.user_id = v_uid and rr.status = 'completed'
  order by rr.round_number desc limit 1;

  if m.round_id is null then
    if cardinality(private.match_ineligibility(p_event, v_uid)) > 0 then
      return v_base || jsonb_build_object('state', 'ineligible',
        'reasons', to_jsonb(private.match_ineligibility(p_event, v_uid)));
    end if;
    return v_base || jsonb_build_object('state', 'matching');
  end if;

  if m.assignment_id is null then
    return v_base || jsonb_build_object('state', 'unmatched', 'awaiting_rematch', r.awaiting_match_since is not null);
  end if;

  select * into a from public.match_assignments where id = m.assignment_id;
  if a.status <> 'active' then
    return v_base || jsonb_build_object('state', 'match_unavailable', 'awaiting_rematch', r.awaiting_match_since is not null);
  end if;

  v_side := case when a.user_a = v_uid then 'a' else 'b' end;
  v_partner := case when v_side = 'a' then a.user_b else a.user_a end;

  select choice into v_choice from public.match_followups where assignment_id = a.id and user_id = v_uid;
  select case when count(*) = 0 then null when bool_or(kind = 'mentorship') then 'mutual_mentorship' else 'mutual_connect' end
    into v_outcome
  from public.connections c
  where c.user_a = least(v_uid, v_partner) and c.user_b = greatest(v_uid, v_partner)
    and c.source = 'primary_followup' and c.event_id = p_event;

  return v_base || jsonb_build_object(
    'state', 'matched',
    'assignment_id', a.id,
    'score', a.score,
    'reasons', coalesce(a.reasons -> v_side, '[]'::jsonb),
    'conversation_starter', a.starters ->> v_side,
    'match', private.profile_card(v_partner, 'match'),
    'my_followup', v_choice,
    'followup_outcome', v_outcome,
    'feedback_submitted', exists (select 1 from public.match_feedback where assignment_id = a.id and user_id = v_uid)
  );
end $$;

create or replace function private.assert_revealed_party(p_assignment uuid, p_user uuid) returns public.match_assignments
language plpgsql stable security definer set search_path = public as $$
declare a public.match_assignments;
begin
  select * into a from public.match_assignments where id = p_assignment;
  if not found or p_user not in (a.user_a, a.user_b) then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not private.primary_revealed(a.event_id) then raise exception 'not_found' using errcode = 'P0002'; end if;
  return a;
end $$;

-- Blind, mutual follow-up: neither side learns the other's choice unless both
-- choices are compatible, in which case a connection is created for both.
create or replace function public.submit_match_followup(p_assignment uuid, p_choice public.followup_choice)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := private.require_auth(); a public.match_assignments; v_partner uuid;
  v_other public.followup_choice; v_outcome text; v_slug text;
begin
  a := private.assert_revealed_party(p_assignment, v_uid);
  if a.status <> 'active' then raise exception 'match_unavailable' using errcode = 'P0001'; end if;
  v_partner := case when a.user_a = v_uid then a.user_b else a.user_a end;

  if exists (select 1 from public.connections where user_a = least(v_uid, v_partner) and user_b = greatest(v_uid, v_partner)
             and source = 'primary_followup' and event_id = a.event_id) then
    raise exception 'already_decided' using errcode = 'P0001';
  end if;

  insert into public.match_followups (assignment_id, user_id, choice) values (a.id, v_uid, p_choice)
  on conflict (assignment_id, user_id) do update set choice = excluded.choice;

  select choice into v_other from public.match_followups where assignment_id = a.id and user_id = v_partner;
  if v_other is not null and p_choice <> 'thanks' and v_other <> 'thanks' and not private.is_blocked(v_uid, v_partner) then
    insert into public.connections (user_a, user_b, kind, source, event_id)
    values (least(v_uid, v_partner), greatest(v_uid, v_partner), 'connect', 'primary_followup', a.event_id)
    on conflict (user_a, user_b, kind) do nothing;
    v_outcome := 'mutual_connect';
    if (p_choice = 'mentor' and v_other = 'mentee') or (p_choice = 'mentee' and v_other = 'mentor') then
      insert into public.connections (user_a, user_b, kind, mentor_id, source, event_id)
      values (least(v_uid, v_partner), greatest(v_uid, v_partner), 'mentorship',
              case when p_choice = 'mentor' then v_uid else v_partner end, 'primary_followup', a.event_id)
      on conflict (user_a, user_b, kind) do nothing;
      v_outcome := 'mutual_mentorship';
    end if;
    select slug into v_slug from public.events where id = a.event_id;
    perform private.notify(v_uid, 'mutual_followup', 'It''s mutual!',
      'You both want to stay in touch. Contact details are now in Connections.', '/connections');
    perform private.notify(v_partner, 'mutual_followup', 'It''s mutual!',
      'You both want to stay in touch. Contact details are now in Connections.', '/connections');
  end if;
  return jsonb_build_object('choice', p_choice, 'outcome', v_outcome);
end $$;

create or replace function public.submit_match_feedback(
  p_assignment uuid, p_rating int, p_met_in_person boolean, p_event_rating int default null, p_comment text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); a public.match_assignments;
begin
  a := private.assert_revealed_party(p_assignment, v_uid);
  insert into public.match_feedback (assignment_id, event_id, user_id, rating, met_in_person, event_rating, comment)
  values (a.id, a.event_id, v_uid, p_rating, p_met_in_person, p_event_rating, nullif(btrim(p_comment), ''))
  on conflict (assignment_id, user_id) do update set rating = excluded.rating, met_in_person = excluded.met_in_person,
    event_rating = excluded.event_rating, comment = excluded.comment;
end $$;

-- ---------------------------------------------------------------------------
-- Post-event recommendations (reveal-gated, re-filtered at read time)
-- ---------------------------------------------------------------------------
create or replace function private.outgoing_request_status(p_from uuid, p_to uuid) returns text
language sql stable security definer set search_path = public as $$
  -- Declines are reported as 'pending' to the requester.
  select case
    when private.connected(p_from, p_to) then 'connected'
    when exists (select 1 from public.connection_requests where requester_id = p_from and recipient_id = p_to
                 and status in ('pending', 'declined')) then 'pending'
    else null end
$$;

create or replace function public.get_my_recommendations(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); e public.events; r public.event_registrations; v_items jsonb;
begin
  select * into e from public.events where id = p_event and status <> 'draft';
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select * into r from public.event_registrations where event_id = p_event and user_id = v_uid;
  if not found or r.status not in ('registered', 'checked_in') then
    return jsonb_build_object('state', 'not_registered', 'server_now', now());
  end if;
  if not r.recommendations_opt_in then
    return jsonb_build_object('state', 'not_opted_in', 'server_now', now(), 'reveal_at', e.post_event_reveal_at);
  end if;
  if not private.recommendations_revealed(p_event) then
    return jsonb_build_object('state', 'waiting', 'server_now', now(), 'reveal_at', e.post_event_reveal_at, 'paused', e.is_paused);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', x.recommended_user_id,
      'rank', x.display_rank,
      'reasons', to_jsonb(x.reasons),
      'profile', private.profile_card(x.recommended_user_id, 'recommendation'),
      'saved', exists (select 1 from public.saved_profiles s where s.user_id = v_uid and s.saved_user_id = x.recommended_user_id),
      'request_status', private.outgoing_request_status(v_uid, x.recommended_user_id),
      'incoming_request_id', (select cr.id from public.connection_requests cr where cr.requester_id = x.recommended_user_id
                                and cr.recipient_id = v_uid and cr.status = 'pending' limit 1)
    ) order by x.display_rank), '[]'::jsonb) into v_items
  from (
    select rec.*, row_number() over (order by rec.rank) as display_rank
    from public.recommendations rec
    join public.event_registrations er on er.event_id = rec.event_id and er.user_id = rec.recommended_user_id
    join public.profiles pr on pr.id = rec.recommended_user_id
    where rec.event_id = p_event and rec.user_id = v_uid
      and er.status in ('registered', 'checked_in') and er.recommendations_opt_in
      and pr.suspended_at is null
      and not private.is_blocked(v_uid, rec.recommended_user_id)
  ) x;

  return jsonb_build_object('state', 'available', 'server_now', now(), 'reveal_at', e.post_event_reveal_at, 'items', v_items);
end $$;

create or replace function private.can_see_person(p_viewer uuid, p_subject uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not private.is_blocked(p_viewer, p_subject) and (
    private.revealed_recommendation(p_viewer, p_subject)
    or private.revealed_match_between(p_viewer, p_subject) is not null
    or private.connected(p_viewer, p_subject))
$$;

create or replace function public.save_profile(p_user uuid, p_event uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth();
begin
  if not private.can_see_person(v_uid, p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.enforce_rate_limit('save_profile', 100, interval '1 hour');
  insert into public.saved_profiles (user_id, saved_user_id, event_id) values (v_uid, p_user, p_event)
  on conflict do nothing;
end $$;

create or replace function public.unsave_profile(p_user uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.saved_profiles where user_id = auth.uid() and saved_user_id = p_user
$$;

create or replace function public.my_saved_profiles() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', s.saved_user_id,
    'event_id', s.event_id,
    'event_name', e.name,
    'saved_at', s.created_at,
    'profile', private.profile_card(s.saved_user_id,
       case when private.connected(auth.uid(), s.saved_user_id) then 'connection' else 'recommendation' end),
    'request_status', private.outgoing_request_status(auth.uid(), s.saved_user_id)
  ) order by s.created_at desc), '[]'::jsonb)
  from public.saved_profiles s left join public.events e on e.id = s.event_id
  where s.user_id = auth.uid() and private.can_see_person(auth.uid(), s.saved_user_id)
$$;

-- ---------------------------------------------------------------------------
-- Connection requests (mutual by construction)
-- ---------------------------------------------------------------------------
create or replace function private.create_connection(p_a uuid, p_b uuid, p_kind public.connection_kind, p_mentor uuid, p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.connections (user_a, user_b, kind, source, event_id)
  values (least(p_a, p_b), greatest(p_a, p_b), 'connect', 'request', p_event)
  on conflict (user_a, user_b, kind) do nothing;
  if p_kind = 'mentorship' then
    insert into public.connections (user_a, user_b, kind, mentor_id, source, event_id)
    values (least(p_a, p_b), greatest(p_a, p_b), 'mentorship', p_mentor, 'request', p_event)
    on conflict (user_a, user_b, kind) do nothing;
  end if;
end $$;

create or replace function public.send_connection_request(
  p_recipient uuid, p_event uuid default null, p_kind public.connection_kind default 'connect',
  p_mentorship_role text default null, p_message text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); v_reverse public.connection_requests; v_name text; v_mentor uuid;
begin
  if p_recipient = v_uid then raise exception 'invalid_input:self' using errcode = '22023'; end if;
  if p_kind = 'mentorship' and coalesce(p_mentorship_role, '') not in ('mentor', 'mentee') then
    raise exception 'invalid_input:mentorship_role' using errcode = '22023';
  end if;
  if p_kind = 'connect' then p_mentorship_role := null; end if;
  if char_length(coalesce(p_message, '')) > 300 then raise exception 'invalid_input:message_too_long' using errcode = '22023'; end if;

  -- Only people you were actually introduced to (and who haven't blocked you).
  if not private.can_see_person(v_uid, p_recipient)
     or exists (select 1 from public.profiles where id = p_recipient and suspended_at is not null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.connections where user_a = least(v_uid, p_recipient) and user_b = greatest(v_uid, p_recipient) and kind = p_kind) then
    return jsonb_build_object('status', 'connected');
  end if;

  perform private.enforce_rate_limit('connection_request', 20, interval '1 hour');

  -- They already asked us: accepting is mutual agreement.
  select * into v_reverse from public.connection_requests
   where requester_id = p_recipient and recipient_id = v_uid and kind = p_kind and status = 'pending'
     and (p_kind = 'connect' or requester_mentorship_role <> p_mentorship_role)
   limit 1;
  if found then
    return public.respond_connection_request(v_reverse.id, true);
  end if;

  -- A previous decline stays private: report pending, don't re-notify.
  if exists (select 1 from public.connection_requests where requester_id = v_uid and recipient_id = p_recipient
             and kind = p_kind and status in ('pending', 'declined')) then
    return jsonb_build_object('status', 'pending');
  end if;

  insert into public.connection_requests (requester_id, recipient_id, event_id, kind, requester_mentorship_role, message)
  values (v_uid, p_recipient, p_event, p_kind, p_mentorship_role, nullif(btrim(p_message), ''));

  select split_part(coalesce(full_name, 'Someone'), ' ', 1) into v_name from public.profiles where id = v_uid;
  perform private.notify(p_recipient, 'connection_request',
    case when p_kind = 'mentorship' then v_name || ' would like to explore mentorship' else v_name || ' would like to connect' end,
    'Accept to exchange the contact details you each chose to share.', '/connections');
  return jsonb_build_object('status', 'pending');
end $$;

create or replace function public.respond_connection_request(p_request uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); q public.connection_requests; v_name text;
begin
  select * into q from public.connection_requests where id = p_request for update;
  if not found or q.recipient_id <> v_uid then raise exception 'not_found' using errcode = 'P0002'; end if;
  if q.status <> 'pending' then raise exception 'already_decided' using errcode = 'P0001'; end if;

  if not p_accept then
    update public.connection_requests set status = 'declined', responded_at = now() where id = q.id;
    return jsonb_build_object('status', 'declined');
  end if;
  if private.is_blocked(q.requester_id, q.recipient_id) then raise exception 'not_found' using errcode = 'P0002'; end if;

  update public.connection_requests set status = 'accepted', responded_at = now() where id = q.id;
  perform private.create_connection(q.requester_id, q.recipient_id, q.kind,
    case when q.kind = 'mentorship' then case when q.requester_mentorship_role = 'mentor' then q.requester_id else q.recipient_id end end,
    q.event_id);
  select split_part(coalesce(full_name, 'Someone'), ' ', 1) into v_name from public.profiles where id = v_uid;
  perform private.notify(q.requester_id, 'connection_accepted', v_name || ' accepted your request',
    'You can now see the contact details they chose to share.', '/connections');
  return jsonb_build_object('status', 'connected');
end $$;

create or replace function public.cancel_connection_request(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.connection_requests set status = 'cancelled', responded_at = now()
   where id = p_request and requester_id = private.require_auth() and status in ('pending', 'declined');
end $$;

create or replace function public.my_connection_requests() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'requester_mentorship_role', q.requester_mentorship_role,
        'message', q.message, 'created_at', q.created_at, 'event_name', e.name,
        'profile', private.profile_card(q.requester_id, 'request')) order by q.created_at desc)
      from public.connection_requests q left join public.events e on e.id = q.event_id
      where q.recipient_id = auth.uid() and q.status = 'pending' and not private.is_blocked(q.requester_id, q.recipient_id)
    ), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'requester_mentorship_role', q.requester_mentorship_role,
        'created_at', q.created_at, 'event_name', e.name,
        'status', case when q.status = 'accepted' then 'accepted' else 'pending' end,
        'profile', private.profile_card(q.recipient_id, 'recommendation')) order by q.created_at desc)
      from public.connection_requests q left join public.events e on e.id = q.event_id
      where q.requester_id = auth.uid() and q.status in ('pending', 'declined', 'accepted')
        and not private.is_blocked(q.requester_id, q.recipient_id)
    ), '[]'::jsonb)
  )
$$;

create or replace function public.my_connections() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', x.other_id, 'kinds', x.kinds, 'mentor_id', x.mentor_id, 'since', x.since, 'event_name', x.event_name,
      'profile', private.profile_card(x.other_id, 'connection'),
      'resume_available', public.can_view_resume(x.other_id)
    ) order by x.since desc), '[]'::jsonb)
  from (
    select case when c.user_a = auth.uid() then c.user_b else c.user_a end as other_id,
           jsonb_agg(distinct c.kind) as kinds, max(c.mentor_id::text)::uuid as mentor_id,
           min(c.created_at) as since, max(e.name) as event_name
    from public.connections c left join public.events e on e.id = c.event_id
    where auth.uid() in (c.user_a, c.user_b)
    group by 1
  ) x
$$;

create or replace function public.remove_connection(p_user uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.connections where user_a = least(auth.uid(), p_user) and user_b = greatest(auth.uid(), p_user)
$$;

-- ---------------------------------------------------------------------------
-- Blocking & reporting
-- ---------------------------------------------------------------------------
create or replace function public.block_user(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); v_assignment record;
begin
  if p_user = v_uid then raise exception 'invalid_input:self' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.enforce_rate_limit('block', 50, interval '1 day');
  insert into public.blocks (blocker_id, blocked_id) values (v_uid, p_user) on conflict do nothing;

  update public.connection_requests set status = 'cancelled', responded_at = now()
   where status = 'pending' and ((requester_id = v_uid and recipient_id = p_user) or (requester_id = p_user and recipient_id = v_uid));
  delete from public.connections where user_a = least(v_uid, p_user) and user_b = greatest(v_uid, p_user);
  delete from public.saved_profiles where (user_id = v_uid and saved_user_id = p_user) or (user_id = p_user and saved_user_id = v_uid);
  delete from public.recommendations where (user_id = v_uid and recommended_user_id = p_user) or (user_id = p_user and recommended_user_id = v_uid);

  for v_assignment in
    select a.id from public.match_assignments a
    where a.status = 'active' and a.user_a = least(v_uid, p_user) and a.user_b = greatest(v_uid, p_user)
  loop
    perform private.cancel_assignment(v_assignment.id, 'blocked', v_uid);
  end loop;
end $$;

create or replace function public.unblock_user(p_user uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.blocks where blocker_id = auth.uid() and blocked_id = p_user
$$;

create or replace function public.my_blocks() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', b.blocked_id, 'full_name', p.full_name, 'blocked_at', b.created_at)
    order by b.created_at desc), '[]'::jsonb)
  from public.blocks b left join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid()
$$;

create or replace function public.report_user(p_user uuid, p_category text, p_details text default null, p_event uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); v_id uuid; v_admin uuid;
begin
  if p_user = v_uid then raise exception 'invalid_input:self' using errcode = '22023'; end if;
  if not private.can_see_person(v_uid, p_user)
     and not exists (select 1 from public.connection_requests where requester_id = p_user and recipient_id = v_uid) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.enforce_rate_limit('report', 10, interval '1 day');
  insert into public.reports (reporter_id, reported_user_id, event_id, category, details)
  values (v_uid, p_user, p_event, p_category, nullif(btrim(p_details), '')) returning id into v_id;
  for v_admin in select user_id from public.user_roles where role = 'admin' loop
    perform private.notify(v_admin, 'report_created', 'New report to review', 'A member submitted a safety report.', '/admin');
  end loop;
  perform private.audit(p_event, 'report.created', 'report', v_id::text, jsonb_build_object('category', p_category));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Profile helpers
-- ---------------------------------------------------------------------------
-- What others will see, per context, rendered with the real server rules.
create or replace function public.get_profile_preview(p_context text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_context not in ('match', 'recommendation', 'connection') then
    raise exception 'invalid_input:context' using errcode = '22023';
  end if;
  return private.profile_card(private.require_auth(), p_context);
end $$;

create or replace function public.record_resume_upload(p_path text, p_file_name text, p_size int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); v_old text;
begin
  if split_part(p_path, '/', 1) <> v_uid::text then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.enforce_rate_limit('resume_upload', 10, interval '1 hour');
  select storage_path into v_old from public.resumes where user_id = v_uid;
  insert into public.resumes (user_id, storage_path, file_name, size_bytes, mime_type)
  values (v_uid, p_path, left(p_file_name, 200), p_size, 'application/pdf')
  on conflict (user_id) do update set storage_path = excluded.storage_path, file_name = excluded.file_name,
    size_bytes = excluded.size_bytes, uploaded_at = now();
  return jsonb_build_object('previous_path', case when v_old is distinct from p_path then v_old end);
end $$;

create or replace function public.delete_resume() returns text
language sql security definer set search_path = public as $$
  delete from public.resumes where user_id = auth.uid() returning storage_path
$$;

create or replace function public.mark_all_notifications_read() returns void
language sql security definer set search_path = public as $$
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null
$$;

create or replace function public.request_organiser_access(p_organisation text, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_auth(); v_auto boolean;
begin
  if private.user_has_role(v_uid, 'organiser') then return 'approved'; end if;
  perform private.enforce_rate_limit('organiser_application', 3, interval '1 day');
  select coalesce((value)::text::boolean, false) into v_auto from public.platform_settings where key = 'organiser_auto_approve';
  insert into public.organiser_applications (user_id, organisation, reason, status, decided_at)
  values (v_uid, btrim(p_organisation), btrim(p_reason), case when v_auto then 'approved'::public.application_status else 'pending' end,
          case when v_auto then now() end);
  if v_auto then
    insert into public.user_roles (user_id, role) values (v_uid, 'organiser') on conflict do nothing;
    return 'approved';
  end if;
  return 'pending';
end $$;

-- Called by the delete-account edge function (service role) before the auth
-- user is removed, so partners are handled like a normal withdrawal.
create or replace function public.service_prepare_account_deletion(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select event_id from public.event_registrations where user_id = p_user and status in ('registered', 'checked_in') loop
    perform private.withdraw_user(r.event_id, p_user, 'withdrawn', 'account_deleted');
  end loop;
  insert into public.audit_logs (actor_id, action, target_type, target_id) values (null, 'account.deleted', 'user', p_user::text);
end $$;
