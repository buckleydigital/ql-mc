-- Watch proposals going cold, and say it once.
-- Applied to production 2026-09-18; recorded here so the repo matches.
--
-- followup_overdue keyed off leads.next_followup, which is set on ZERO of the
-- 15 open leads and zero of the 72 lost in the last ninety days. A rule against
-- a field nobody fills can never fire - it was dead on arrival.
--
-- What the data does carry says plenty: 13 leads in 'proposal', twelve of them
-- untouched for 14 days or more, the oldest at 36. A proposal quiet for a month
-- is a deal dying of silence rather than of rejection, and that is the one
-- thing on this board an alert can actually save.
create or replace function public.jarvis_scan()
returns table (kind text, dedup_key text, tier text, subject text, payload jsonb)
language sql
stable
security invoker
set search_path = public
as $$
  -- Tiered by age: a week is a nudge, a month is a loss. Over 14 days rings the
  -- phone, 7 to 14 texts.
  select
    'proposal_cold'::text,
    'proposal_cold:' || l.id::text,
    case when l.updated_at < now() - interval '14 days' then 'urgent' else 'notable' end,
    coalesce(nullif(l.company, ''), l.name, 'Unnamed lead'),
    jsonb_build_object(
      'lead_id', l.id,
      'days', floor(extract(epoch from (now() - l.updated_at)) / 86400),
      'value', l.value
    )
  from public.leads l
  where l.stage = 'proposal'
    and l.updated_at < now() - interval '7 days'
  union all
  -- Kept but secondary: fires only where a rep actually set a date, which is
  -- currently nowhere. Harmless, and it starts working the day they do.
  select
    'followup_overdue'::text,
    'followup_overdue:' || l.id::text,
    'notable'::text,
    coalesce(nullif(l.company, ''), l.name, 'Unnamed lead'),
    jsonb_build_object('lead_id', l.id, 'due', l.next_followup, 'stage', l.stage)
  from public.leads l
  where l.next_followup is not null
    and l.next_followup < now() - interval '2 hours'
    and l.stage not in ('closed_won', 'closed_lost')
  union all
  select
    'fulfilment_overdue'::text,
    'fulfilment_overdue:' || c.id::text,
    'notable'::text,
    coalesce(nullif(c.company_name, ''), 'Unnamed client'),
    jsonb_build_object('client_id', c.id, 'step', c.fulfilment_next_step,
      'due', c.fulfilment_next_due)
  from public.clients c
  where c.fulfilment_next_due is not null and c.fulfilment_next_due < now()
    and coalesce(c.stage, '') not in ('churned', 'paused')
  union all
  select
    'fulfilment_blocked'::text,
    'fulfilment_blocked:' || c.id::text,
    'urgent'::text,
    coalesce(nullif(c.company_name, ''), 'Unnamed client'),
    jsonb_build_object('client_id', c.id, 'blocked', c.fulfilment_blocked_count)
  from public.clients c
  where coalesce(c.fulfilment_blocked_count, 0) > 0
    and coalesce(c.stage, '') not in ('churned', 'paused');
$$;

-- Say it once, ever.
--
-- The recurrence rule clears notified_at when an event resolves and comes back,
-- which is right for a blocked client: it going wrong twice is two facts. It is
-- wrong for a cold proposal - chase one, it warms up and resolves, a quiet week
-- later it is cold again and he rings about the same deal. From the owner's
-- side that is the same reminder twice, and being nagged about a deal you
-- already know about is how an assistant gets muted.
--
-- Also drops the temp table first: it is ON COMMIT DROP, so a second call in
-- the same transaction hit "relation _scan already exists". The cron calls it
-- once per request so production never saw it, but a test or a future caller
-- that scans twice would fail on a detail unrelated to what it was doing.
create or replace function public.jarvis_apply_scan()
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  opened integer;
begin
  drop table if exists _scan;
  create temp table _scan on commit drop as select * from public.jarvis_scan();

  insert into public.jarvis_events (kind, dedup_key, tier, subject, payload)
  select s.kind, s.dedup_key, s.tier, s.subject, s.payload from _scan s
  on conflict (dedup_key) do update
    set last_seen_at = now(),
        tier         = excluded.tier,
        subject      = excluded.subject,
        payload      = excluded.payload,
        notified_at  = case
                         when public.jarvis_events.kind = 'proposal_cold'
                           then public.jarvis_events.notified_at
                         when public.jarvis_events.resolved_at is not null
                           then null
                         else public.jarvis_events.notified_at
                       end,
        resolved_at  = null;

  update public.jarvis_events e
     set resolved_at = now()
   where e.resolved_at is null
     and not exists (select 1 from _scan s where s.dedup_key = e.dedup_key);

  select count(*) into opened
  from public.jarvis_events
  where notified_at is null and resolved_at is null
    and (snoozed_until is null or snoozed_until < now());

  return opened;
end $$;

revoke all on function public.jarvis_scan()       from public, anon, authenticated;
revoke all on function public.jarvis_apply_scan() from public, anon, authenticated;
grant execute on function public.jarvis_scan()       to service_role;
grant execute on function public.jarvis_apply_scan() to service_role;
