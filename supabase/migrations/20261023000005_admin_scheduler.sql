-- Platform administration, the server-side scheduler tick and retention.

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_admin();
begin
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'organisers', (select count(*) from public.user_roles where role = 'organiser'),
    'events', (select jsonb_object_agg(status, n) from (select status, count(*) n from public.events group by status) x),
    'open_reports', (select count(*) from public.reports where status in ('open', 'reviewing')),
    'pending_applications', (select count(*) from public.organiser_applications where status = 'pending'),
    'settings', (select jsonb_object_agg(key, value) from public.platform_settings)
  );
end $$;

create or replace function public.admin_list_applications(p_status public.application_status default 'pending') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_admin();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'user_id', a.user_id, 'full_name', p.full_name, 'email', u.email,
            'organisation', a.organisation, 'reason', a.reason, 'status', a.status, 'created_at', a.created_at,
            'decision_note', a.decision_note) order by a.created_at desc), '[]'::jsonb)
          from public.organiser_applications a join auth.users u on u.id = a.user_id left join public.profiles p on p.id = a.user_id
          where a.status = p_status);
end $$;

create or replace function public.admin_decide_application(p_application uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_admin(); a public.organiser_applications;
begin
  select * into a from public.organiser_applications where id = p_application for update;
  if not found or a.status <> 'pending' then raise exception 'not_found' using errcode = 'P0002'; end if;
  update public.organiser_applications set status = case when p_approve then 'approved'::public.application_status else 'rejected' end,
    decided_by = v_uid, decided_at = now(), decision_note = nullif(btrim(p_note), '') where id = a.id;
  if p_approve then
    insert into public.user_roles (user_id, role, granted_by) values (a.user_id, 'organiser', v_uid) on conflict do nothing;
  end if;
  perform private.notify(a.user_id, 'organiser_application',
    case when p_approve then 'You can now host events on Meetwise' else 'Update on your organiser request' end,
    case when p_approve then 'Head to the organiser dashboard to create your first event.' else coalesce(p_note, 'Your request was not approved this time.') end,
    case when p_approve then '/organiser' else '/settings' end);
  perform private.audit(null, 'admin.application_' || case when p_approve then 'approved' else 'rejected' end, 'user', a.user_id::text);
end $$;

create or replace function public.admin_search_users(p_query text default '') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_admin();
begin
  return (select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', u.id, 'email', u.email, 'full_name', p.full_name, 'created_at', u.created_at,
      'suspended', p.suspended_at is not null, 'suspended_reason', p.suspended_reason,
      'roles', (select coalesce(jsonb_agg(role), '[]'::jsonb) from public.user_roles r where r.user_id = u.id),
      'open_reports', (select count(*) from public.reports r where r.reported_user_id = u.id and r.status in ('open','reviewing'))) x
    from auth.users u left join public.profiles p on p.id = u.id
    where coalesce(p_query, '') = '' or u.email ilike '%' || p_query || '%' or p.full_name ilike '%' || p_query || '%'
    order by u.created_at desc limit 50) t);
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role public.app_role, p_grant boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_admin();
begin
  if p_role = 'attendee' then raise exception 'invalid_input:role' using errcode = '22023'; end if;
  if not p_grant and p_role = 'admin' and p_user = v_uid then raise exception 'invalid_input:cannot_remove_own_admin' using errcode = '22023'; end if;
  if p_grant then
    insert into public.user_roles (user_id, role, granted_by) values (p_user, p_role, v_uid) on conflict do nothing;
  else
    delete from public.user_roles where user_id = p_user and role = p_role;
  end if;
  perform private.audit(null, 'admin.role_' || case when p_grant then 'granted' else 'revoked' end, 'user', p_user::text,
    jsonb_build_object('role', p_role));
end $$;

create or replace function public.admin_set_suspension(p_user uuid, p_suspend boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_admin(); v_assignment record;
begin
  if p_user = v_uid then raise exception 'invalid_input:self' using errcode = '22023'; end if;
  update public.profiles set suspended_at = case when p_suspend then now() end,
    suspended_reason = case when p_suspend then left(p_reason, 300) end where id = p_user;
  if p_suspend then
    -- Suspended members leave active matches and recommendation lists.
    for v_assignment in select a.id from public.match_assignments a
      where a.status = 'active' and p_user in (a.user_a, a.user_b) loop
      perform private.cancel_assignment(v_assignment.id, 'removed', p_user);
    end loop;
    delete from public.recommendations where recommended_user_id = p_user or user_id = p_user;
    update public.connection_requests set status = 'cancelled' where status = 'pending' and p_user in (requester_id, recipient_id);
  end if;
  perform private.audit(null, case when p_suspend then 'admin.user_suspended' else 'admin.user_unsuspended' end, 'user', p_user::text,
    jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.admin_list_reports(p_status public.report_status default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_admin();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'category', r.category, 'details', r.details, 'status', r.status,
            'created_at', r.created_at, 'resolution_note', r.resolution_note, 'event_name', e.name,
            'reporter', jsonb_build_object('id', r.reporter_id, 'full_name', pr.full_name),
            'reported', jsonb_build_object('id', r.reported_user_id, 'full_name', pd.full_name, 'suspended', pd.suspended_at is not null)
          ) order by r.created_at desc), '[]'::jsonb)
          from public.reports r left join public.profiles pr on pr.id = r.reporter_id
          left join public.profiles pd on pd.id = r.reported_user_id left join public.events e on e.id = r.event_id
          where p_status is null or r.status = p_status);
end $$;

create or replace function public.admin_resolve_report(p_report uuid, p_status public.report_status, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_admin();
begin
  update public.reports set status = p_status, resolution_note = nullif(btrim(p_note), ''),
    resolved_by = case when p_status in ('resolved', 'dismissed') then v_uid end,
    resolved_at = case when p_status in ('resolved', 'dismissed') then now() end
  where id = p_report;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.audit(null, 'admin.report_' || p_status, 'report', p_report::text);
end $$;

create or replace function public.admin_update_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := private.require_admin(); v jsonb := p_value;
begin
  case p_key
    when 'default_matching_weights' then v := private.validate_weights(p_value);
    when 'default_role_rules' then v := private.validate_rules(p_value);
    when 'organiser_auto_approve' then
      if jsonb_typeof(p_value) <> 'boolean' then raise exception 'invalid_input:value' using errcode = '22023'; end if;
    when 'retention' then
      v := jsonb_build_object(
        'archive_events_after_days', greatest(1, least(3650, coalesce((p_value ->> 'archive_events_after_days')::int, 30))),
        'delete_resumes_after_days', greatest(1, least(3650, coalesce((p_value ->> 'delete_resumes_after_days')::int, 180))),
        'delete_notifications_after_days', greatest(7, least(3650, coalesce((p_value ->> 'delete_notifications_after_days')::int, 180))),
        'delete_audit_after_days', greatest(30, least(3650, coalesce((p_value ->> 'delete_audit_after_days')::int, 730))));
    else raise exception 'invalid_input:key' using errcode = '22023';
  end case;
  update public.platform_settings set value = v, updated_by = v_uid, updated_at = now() where key = p_key;
  perform private.audit(null, 'admin.setting_updated', 'setting', p_key, jsonb_build_object('value', v));
end $$;

create or replace function public.admin_list_events() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_admin();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'slug', e.slug, 'name', e.name, 'status', e.status,
            'is_paused', e.is_paused, 'starts_at', e.starts_at, 'created_at', e.created_at,
            'registered', (select count(*) from public.event_registrations r where r.event_id = e.id and r.status in ('registered','checked_in')),
            'owner', (select p.full_name from public.event_organisers o join public.profiles p on p.id = o.user_id
                      where o.event_id = e.id and o.role = 'owner' limit 1)) order by e.created_at desc), '[]'::jsonb)
          from public.events e);
end $$;

create or replace function public.admin_audit_log() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := private.require_admin();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'action', l.action, 'actor', p.full_name, 'event_id', l.event_id,
            'target_type', l.target_type, 'target_id', l.target_id, 'details', l.details, 'created_at', l.created_at)
            order by l.created_at desc), '[]'::jsonb)
          from (select * from public.audit_logs order by created_at desc limit 200) l left join public.profiles p on p.id = l.actor_id);
end $$;

-- ---------------------------------------------------------------------------
-- Scheduler tick: run every minute (pg_cron and/or the scheduler edge
-- function). Advances lifecycle states by the server clock, sends reveal
-- notifications exactly once, applies retention, and returns the matching /
-- recommendation work that is due.
-- ---------------------------------------------------------------------------
create or replace function public.service_scheduler_tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e public.events; v_match jsonb := '[]'; v_supp jsonb := '[]'; v_recs jsonb := '[]'; v_ret jsonb; v_user record;
  v_has_primary boolean; v_running boolean;
begin
  select value into v_ret from public.platform_settings where key = 'retention';

  -- Stale jobs are failed so they can be retried.
  perform public.service_fail_match_round(r.id, 'stale: job did not complete')
    from public.match_rounds r where r.status = 'running' and r.started_at < now() - interval '10 minutes';

  for e in select * from public.events where status not in ('draft', 'archived') and not is_paused for update skip locked loop
    if e.status = 'registration_open' and e.registration_deadline <= now() then
      update public.events set status = 'registration_closed' where id = e.id returning * into e;
      insert into public.audit_logs (event_id, action, target_type, target_id) values (e.id, 'event.registration_closed_auto', 'event', e.id::text);
    end if;

    if e.status = 'primary_ready' and e.primary_reveal_at <= now() then
      update public.events set status = 'primary_revealed' where id = e.id returning * into e;
    end if;

    if e.status in ('primary_revealed', 'event_ended', 'recommendations_available') and e.primary_notified_at is null
       and e.primary_reveal_at <= now() then
      for v_user in
        select m.user_id, m.assignment_id from public.match_round_members m join public.match_rounds r on r.id = m.round_id
        where r.event_id = e.id and r.status = 'completed'
      loop
        perform private.notify(v_user.user_id, 'match_ready',
          case when v_user.assignment_id is not null then 'Your match at ' || e.name || ' is here' else 'Matching update for ' || e.name end,
          case when v_user.assignment_id is not null then 'Open Meetwise to meet the person we picked for you.'
               else 'We couldn''t find a strong match this round. Your recommendations are still coming.' end,
          '/e/' || e.slug || '/match');
      end loop;
      update public.events set primary_notified_at = now() where id = e.id returning * into e;
    end if;

    if e.status in ('registration_closed', 'matching_in_progress', 'primary_ready', 'primary_revealed') and e.ends_at <= now() then
      update public.events set status = 'event_ended' where id = e.id returning * into e;
      update public.event_registrations set awaiting_match_since = null where event_id = e.id;
    end if;

    if e.status = 'event_ended' and e.recommendations_generated_at is not null and e.post_event_reveal_at <= now() then
      update public.events set status = 'recommendations_available' where id = e.id returning * into e;
    end if;

    if e.status = 'recommendations_available' and e.recommendations_notified_at is null then
      for v_user in select user_id from public.recommendations where event_id = e.id group by user_id loop
        perform private.notify(v_user.user_id, 'recommendations_ready', 'Five more people to meet from ' || e.name,
          'Your post-event recommendations are ready.', '/e/' || e.slug || '/discover');
      end loop;
      update public.events set recommendations_notified_at = now() where id = e.id returning * into e;
    end if;

    if e.status in ('recommendations_available', 'event_ended')
       and e.post_event_reveal_at + make_interval(days => coalesce((v_ret ->> 'archive_events_after_days')::int, 30)) <= now() then
      update public.events set status = 'archived', archived_at = now() where id = e.id returning * into e;
      continue;
    end if;

    -- Work that is due.
    select exists (select 1 from public.match_rounds where event_id = e.id and mode = 'primary' and status = 'completed') into v_has_primary;
    select exists (select 1 from public.match_rounds where event_id = e.id and status = 'running') into v_running;
    if not v_running then
      if e.status = 'registration_closed' and not v_has_primary and e.auto_match_failures < 3 then
        v_match := v_match || to_jsonb(e.id);
      elsif e.status in ('primary_ready', 'primary_revealed') and v_has_primary and e.ends_at > now()
            and coalesce((e.role_rules ->> 'auto_match_late_arrivals')::boolean, true) and e.auto_match_failures < 3
            and exists (select 1 from public.event_registrations r where r.event_id = e.id and r.awaiting_match_since is not null
                        and r.awaiting_match_since < now() - interval '2 minutes') then
        v_supp := v_supp || to_jsonb(e.id);
      end if;
    end if;
    if e.recommendations_generated_at is null and e.post_event_reveal_at - interval '15 minutes' <= now()
       and e.status in ('primary_ready', 'primary_revealed', 'event_ended') then
      v_recs := v_recs || to_jsonb(e.id);
    end if;
  end loop;

  -- Retention.
  delete from public.notifications
   where created_at < now() - make_interval(days => coalesce((v_ret ->> 'delete_notifications_after_days')::int, 180));
  delete from public.audit_logs
   where created_at < now() - make_interval(days => coalesce((v_ret ->> 'delete_audit_after_days')::int, 730));
  delete from public.rate_limit_events where created_at < now() - interval '2 days';

  return jsonb_build_object('server_now', now(), 'match', v_match, 'supplemental', v_supp, 'recommendations', v_recs);
end $$;

-- Resumes older than the retention window (deleted via the Storage API by the
-- scheduler edge function, then the row is removed).
create or replace function public.service_expired_resumes() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'storage_path', storage_path)), '[]'::jsonb)
  from public.resumes
  where uploaded_at < now() - make_interval(days => coalesce(
    (select (value ->> 'delete_resumes_after_days')::int from public.platform_settings where key = 'retention'), 180))
$$;

create or replace function public.service_delete_resume_row(p_user uuid, p_path text) returns void
language sql security definer set search_path = public as $$
  delete from public.resumes where user_id = p_user and storage_path = p_path
$$;

create or replace function public.service_resume_path(p_owner uuid) returns text
language sql stable security definer set search_path = public as $$
  select storage_path from public.resumes where user_id = p_owner
$$;
