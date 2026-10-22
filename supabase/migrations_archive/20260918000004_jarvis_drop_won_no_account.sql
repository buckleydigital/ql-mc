-- Drop the won_no_account watcher.
--
-- It fired on every closed-won lead whose hq_company_id was null, which turned
-- out to be a data-linkage gap rather than a real problem: the accounts existed,
-- the pipeline row just never had the id written back. 21 were backfilled with
-- their real ql-hq company id; the remaining 9 are old deals that will never get
-- an account.
--
-- Retired rather than permanently silenced. A watcher whose alerts nobody acts
-- on is worse than no watcher, because it teaches you to ignore the ones that
-- matter - so the rule goes, and the events it left behind go with it.
--
-- See 20260918000001_jarvis_watch.sql for the original definition; the body
-- below is that one minus the first UNION branch.
create or replace function public.jarvis_scan()
returns table (kind text, dedup_key text, tier text, subject text, payload jsonb)
language sql
stable
security invoker
set search_path = public
as $$
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

revoke all on function public.jarvis_scan() from public, anon, authenticated;
grant execute on function public.jarvis_scan() to service_role;

delete from public.jarvis_events where kind = 'won_no_account';
