-- Cold outreach stats.
--
-- The funnel per niche, from our own records: found -> had an email ->
-- verified -> qualified -> emailed -> replied -> interested -> won, where won
-- is the Sales Pipeline lead it became reaching closed_won (with its value).
-- Counts are "reached at least this far", so each column is a subset of the
-- one before. p_days limits it to prospects found in the last N days; null is
-- all time.
--
-- Plus a daily series (emailed, replies, interested) and the bounce check the
-- webhook uses to pause a niche whose bounce rate climbs - bounces are what
-- get sending domains flagged.

create or replace function public.outreach_funnel(p_days int default null)
returns table (niche_key text, label text, found bigint, with_email bigint, verified bigint, qualified bigint,
               emailed bigint, replied bigint, interested bigint, won bigint, won_value numeric,
               bounced bigint, unsubscribed bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  return query
    with p as (
      select p.*,
             exists (select 1 from public.outreach_events e where e.prospect_id = p.id and e.event_type = 'reply_received') as got_reply,
             l.stage as lead_stage, l.value as lead_value
        from public.prospects p
        left join public.leads l on l.id = p.lead_id
       where p_days is null or p.found_at >= now() - make_interval(days => p_days)
    )
    select n.key, n.label,
           count(p.id),
           count(p.id) filter (where p.email is not null),
           count(p.id) filter (where p.email_verdict in ('valid', 'risky')),
           count(p.id) filter (where p.fit_score >= 6),
           count(p.id) filter (where p.contacted_at is not null),
           count(p.id) filter (where p.got_reply or p.status in ('replied', 'interested', 'not_interested', 'converted')),
           count(p.id) filter (where p.status in ('interested', 'converted') or p.lead_id is not null),
           count(p.id) filter (where p.lead_stage = 'closed_won'),
           coalesce(sum(p.lead_value) filter (where p.lead_stage = 'closed_won'), 0),
           count(p.id) filter (where p.status = 'bounced'),
           count(p.id) filter (where p.status = 'unsubscribed')
      from public.outreach_niches n
      left join p on p.niche_key = n.key
     group by n.key, n.label, n.sort_order
     order by n.sort_order, n.key;
end;
$$;

-- Per day, Brisbane time: first emails sent, replies, and interested.
create or replace function public.outreach_daily(p_days int default 30)
returns table (day date, emailed bigint, replies bigint, interested bigint)
language plpgsql stable security definer set search_path = public as $$
declare d int := least(greatest(coalesce(p_days, 30), 7), 180);
begin
  perform public.jarvis_assert_operator();
  return query
    with days as (
      select generate_series((now() at time zone 'Australia/Brisbane')::date - (d - 1),
                             (now() at time zone 'Australia/Brisbane')::date, interval '1 day')::date as day
    )
    select days.day,
           (select count(*) from public.prospects p where (p.contacted_at at time zone 'Australia/Brisbane')::date = days.day),
           (select count(*) from public.outreach_events e where e.event_type = 'reply_received' and (e.received_at at time zone 'Australia/Brisbane')::date = days.day),
           (select count(*) from public.outreach_events e where e.event_type in ('lead_interested', 'lead_meeting_booked') and (e.received_at at time zone 'Australia/Brisbane')::date = days.day)
      from days order by days.day;
end;
$$;

-- What we spent finding and scoring, over the same window.
create or replace function public.outreach_spend(p_days int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  return (select jsonb_build_object(
            'runs', count(*), 'searches', coalesce(sum(searches), 0), 'verified', coalesce(sum(verified + invalid), 0),
            'ai_cost_usd', coalesce(sum(ai_cost_usd), 0))
            from public.outreach_runs
           where p_days is null or started_at >= now() - make_interval(days => p_days));
end;
$$;

-- Bounce rate of a niche over the last 7 days, for the webhook's auto-pause.
-- Service role only: it is called by outreach-webhook, not the dashboard.
create or replace function public.outreach_bounce_rate(p_niche text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'emailed', count(*) filter (where contacted_at >= now() - interval '7 days'),
    'bounced', count(*) filter (where status = 'bounced' and last_event_at >= now() - interval '7 days'))
    from public.prospects where niche_key = p_niche
$$;

revoke all on function public.outreach_funnel(int)       from public, anon;
revoke all on function public.outreach_daily(int)        from public, anon;
revoke all on function public.outreach_spend(int)        from public, anon;
revoke all on function public.outreach_bounce_rate(text) from public, anon, authenticated;
grant execute on function public.outreach_funnel(int)    to authenticated;
grant execute on function public.outreach_daily(int)     to authenticated;
grant execute on function public.outreach_spend(int)     to authenticated;
grant execute on function public.outreach_bounce_rate(text) to service_role;
