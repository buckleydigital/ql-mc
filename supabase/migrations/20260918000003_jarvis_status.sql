-- Let the Jarvis settings panel show live state.
--
-- jarvis_events is revoked from authenticated and forces RLS with no policies,
-- which is correct - it is internal operational data about which deals are
-- leaking and which clients are stuck. But the admin who configures the alerts
-- needs to see what he is actually watching, or the settings screen is a form
-- with no feedback.
--
-- So: one narrow SECURITY DEFINER function that returns COUNTS and the last
-- message, never the rows themselves. Unlike the scan functions - where DEFINER
-- would have been a pure escalation path - the elevation here is the point, so
-- the authorisation is written into the body rather than left to the grant.
-- account_type comes from the signed JWT, so a rep cannot claim otherwise.
create or replace function public.jarvis_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  acct text;
  result jsonb;
begin
  acct := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  -- Same gate as jarvis-chat: the assistant and anything about him are for the
  -- people who run the business, not for reps or lead buyers.
  if acct in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  -- No JWT at all means anon; nothing here is public.
  if auth.jwt() is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'open_by_kind', coalesce((
      select jsonb_object_agg(kind, n)
      from (
        select kind, count(*) as n
        from public.jarvis_events
        where resolved_at is null
        group by kind
      ) k
    ), '{}'::jsonb),
    'open_total', (
      select count(*) from public.jarvis_events where resolved_at is null
    ),
    'queued', (
      select count(*) from public.jarvis_events
      where resolved_at is null and notified_at is null
        and (snoozed_until is null or snoozed_until < now())
    ),
    'last_sent_at', (
      select max(created_at) from public.jarvis_notifications where status = 'sent'
    ),
    'last_body', (
      select body from public.jarvis_notifications
      where status = 'sent' order by created_at desc limit 1
    )
  ) into result;

  return result;
end $$;

-- Reachable by a logged-in admin through PostgREST, which is the point; the
-- body is what decides, and anon is refused there.
revoke all on function public.jarvis_status() from public;
grant execute on function public.jarvis_status() to authenticated, service_role;
