-- Function execution whitelist. Supabase grants EXECUTE on new functions to
-- anon/authenticated by default; we revoke everything and re-grant only what
-- each role should call. service_* functions are callable by service_role only.

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

-- Pure helpers referenced by table CHECK constraints / triggers.
grant execute on function public.opt_industries(), public.opt_roles(), public.opt_goals(),
  public.opt_profile_fields(), public.opt_contact_fields(), public.valid_tags(text[], int, int),
  public.profile_is_complete(public.profiles)
  to anon, authenticated;

-- Helpers referenced by RLS policies (evaluated as the calling role).
grant execute on function private.is_admin(), private.is_event_organiser(uuid), private.user_has_role(uuid, public.app_role)
  to authenticated;

-- Anonymous + authenticated.
grant execute on function public.get_event_public(text) to anon, authenticated;

-- Authenticated users (each function enforces its own checks).
grant execute on function
  public.is_admin(), public.is_event_organiser(uuid), public.my_roles(), public.can_view_resume(uuid),
  public.register_for_event(text, boolean, boolean, text, text),
  public.update_my_registration(uuid, boolean, boolean),
  public.withdraw_from_event(uuid), public.my_events(), public.get_event_hub(uuid),
  public.get_my_primary_match(uuid), public.submit_match_followup(uuid, public.followup_choice),
  public.submit_match_feedback(uuid, int, boolean, int, text),
  public.get_my_recommendations(uuid), public.save_profile(uuid, uuid), public.unsave_profile(uuid),
  public.my_saved_profiles(),
  public.send_connection_request(uuid, uuid, public.connection_kind, text, text),
  public.respond_connection_request(uuid, boolean), public.cancel_connection_request(uuid),
  public.my_connection_requests(), public.my_connections(), public.remove_connection(uuid),
  public.block_user(uuid), public.unblock_user(uuid), public.my_blocks(),
  public.report_user(uuid, text, text, uuid),
  public.get_profile_preview(text), public.record_resume_upload(text, text, int), public.delete_resume(),
  public.mark_all_notifications_read(), public.request_organiser_access(text, text),
  -- organiser (checked inside)
  public.create_event(jsonb), public.update_event(uuid, jsonb, boolean), public.duplicate_event(uuid),
  public.set_event_status(uuid, text, boolean), public.update_matching_config(uuid, jsonb, jsonb),
  public.add_co_organiser(uuid, text), public.remove_co_organiser(uuid, uuid),
  public.organiser_events(), public.organiser_event_detail(uuid), public.organiser_event_attendees(uuid),
  public.organiser_manage_registration(uuid, uuid, text, text), public.organiser_round_assignments(uuid),
  public.organiser_cancel_assignment(uuid, text), public.event_analytics(uuid), public.event_audit_log(uuid),
  -- admin (checked inside)
  public.admin_overview(), public.admin_list_applications(public.application_status),
  public.admin_decide_application(uuid, boolean, text), public.admin_search_users(text),
  public.admin_set_role(uuid, public.app_role, boolean), public.admin_set_suspension(uuid, boolean, text),
  public.admin_list_reports(public.report_status), public.admin_resolve_report(uuid, public.report_status, text),
  public.admin_update_setting(text, jsonb), public.admin_list_events(), public.admin_audit_log()
  to authenticated;

-- service_role only.
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema private to service_role;

-- ---------------------------------------------------------------------------
-- Scheduling. pg_cron runs the lifecycle tick every minute inside the
-- database (no configuration needed). If pg_net is enabled and the two Vault
-- secrets below exist, the same job also invokes the `scheduler` edge
-- function, which runs matching / recommendation jobs that are due:
--   select vault.create_secret('https://<project>.supabase.co/functions/v1', 'meetwise_functions_url');
--   select vault.create_secret('<service-role-key>', 'meetwise_service_role_key');
-- ---------------------------------------------------------------------------
create or replace function private.cron_tick() returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_key text; v_work jsonb;
begin
  v_work := public.service_scheduler_tick();
  if to_regclass('vault.decrypted_secrets') is null or to_regproc('net.http_post') is null then return; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'meetwise_functions_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_key using 'meetwise_service_role_key';
  if v_url is null or v_key is null then return; end if;
  if jsonb_array_length(v_work -> 'match') + jsonb_array_length(v_work -> 'supplemental') + jsonb_array_length(v_work -> 'recommendations') = 0
     and extract(minute from now())::int % 60 <> 0 then
    return; -- nothing due; still call hourly for resume retention
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3)'
    using v_url || '/scheduler',
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
          jsonb_build_object('source', 'pg_cron', 'work', v_work);
end $$;
revoke execute on function private.cron_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if exists (select 1 from pg_available_extensions where name = 'pg_net') then
      create extension if not exists pg_net;
    end if;
    perform cron.unschedule(jobid) from cron.job where jobname = 'meetwise-tick';
    perform cron.schedule('meetwise-tick', '* * * * *', 'select private.cron_tick()');
  else
    raise notice 'pg_cron not available: run service_scheduler_tick() from the scheduler edge function instead';
  end if;
end $$;
