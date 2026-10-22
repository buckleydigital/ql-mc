-- Jarvis phase 1: a heartbeat, a mailbox, and somewhere to put your number.
--
-- Until now Jarvis only ever spoke when someone opened the panel and typed at
-- him. This gives him a reason to speak first: watchers run on a schedule, find
-- things that are actually wrong, and he texts about them.
--
-- The design keeps facts and speech apart. A WATCHER produces an EVENT, which
-- is a fact about the business and is upserted on a stable key so the same
-- problem is one row however many times it is seen. A NOTIFICATION is a
-- decision to interrupt a human about one or more events, and is logged
-- separately. Tuning what he says must never mean re-detecting what is true.

-- ── Where your number lives ────────────────────────────────────────────────
-- business_settings is a single row that already holds the Twilio from-number,
-- so the notify-to number belongs beside it rather than in a new table or, far
-- worse, an env var that cannot be changed without a deploy.
alter table public.business_settings
  add column if not exists jarvis_notify_number  text,
  add column if not exists jarvis_notify_enabled boolean not null default false,
  -- Quiet hours are local wall-clock times, held with the zone they are read
  -- in; a cron running in UTC must not decide 8pm Sydney is a fine time.
  add column if not exists jarvis_timezone       text    not null default 'Australia/Sydney',
  add column if not exists jarvis_quiet_start    time    not null default '20:00',
  add column if not exists jarvis_quiet_end      time    not null default '07:30',
  -- The backstop that matters. A dedup bug is a phone that buzzes all night;
  -- this caps the damage at a number you chose rather than at whatever the bug
  -- produces. Counted against real sends, so a retry storm cannot slip past.
  add column if not exists jarvis_daily_sms_cap  integer not null default 10;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_settings'::regclass
      and conname  = 'business_settings_jarvis_daily_sms_cap_check'
  ) then
    alter table public.business_settings
      add constraint business_settings_jarvis_daily_sms_cap_check
      check (jarvis_daily_sms_cap >= 0 and jarvis_daily_sms_cap <= 100);
  end if;
end $$;

comment on column public.business_settings.jarvis_notify_number is
  'AU mobile Jarvis sends alerts to. NULL or jarvis_notify_enabled=false means he stays quiet.';

-- ── Events: what is true ───────────────────────────────────────────────────
create table if not exists public.jarvis_events (
  id            uuid primary key default gen_random_uuid(),
  kind          text        not null,
  -- The whole dedup story. '<kind>:<row id>' means the same overdue lead is one
  -- row forever, however often the watcher runs. Without this a 15-minute cron
  -- sends 96 identical texts a day and gets itself muted on day one.
  dedup_key     text        not null unique,
  tier          text        not null check (tier in ('urgent','notable','digest')),
  subject       text,
  payload       jsonb       not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- Set when he has spoken about it. NULL means unspoken, which is the queue.
  notified_at   timestamptz,
  -- Set when a watcher stops returning it, i.e. somebody fixed it. Kept rather
  -- than deleted so "you sorted 4 things today" is answerable, and so a problem
  -- that comes back is visibly a recurrence.
  resolved_at   timestamptz,
  snoozed_until timestamptz
);

create index if not exists jarvis_events_pending_idx
  on public.jarvis_events (tier, first_seen_at)
  where notified_at is null and resolved_at is null;
create index if not exists jarvis_events_open_idx
  on public.jarvis_events (kind) where resolved_at is null;

-- ── Notifications: what was said ───────────────────────────────────────────
create table if not exists public.jarvis_notifications (
  id         uuid primary key default gen_random_uuid(),
  channel    text        not null default 'sms',
  to_number  text        not null,
  tier       text        not null,
  body       text        not null,
  event_ids  uuid[]      not null default '{}',
  twilio_sid text,
  status     text        not null default 'sent',
  error      text,
  created_at timestamptz not null default now()
);

create index if not exists jarvis_notifications_created_idx
  on public.jarvis_notifications (created_at desc);

-- ── The watchers ───────────────────────────────────────────────────────────
-- Plain SQL on purpose. These run every few minutes forever, so they must be
-- cheap and they must be certain: an LLM guessing at whether something is wrong
-- is both slower and less trustworthy than a WHERE clause that says so.
--
-- Each returns the same shape, and the caller upserts the lot. Adding a watcher
-- later means adding a UNION branch here and nothing else.
create or replace function public.jarvis_scan()
returns table (kind text, dedup_key text, tier text, subject text, payload jsonb)
language sql
stable
-- INVOKER, not DEFINER, and deliberately. The only legitimate caller is the
-- jarvis-notify function running as service_role, which bypasses RLS on its own
-- and so needs no elevation. Making it DEFINER would mean that the moment
-- EXECUTE leaks back - and Supabase ships ALTER DEFAULT PRIVILEGES granting
-- functions to authenticated - any logged-in rep could read the whole pipeline
-- through /rest/v1/rpc. As INVOKER the worst case is they see what their own
-- RLS already lets them see, so the revoke below is a second lock rather than
-- the only one.
security invoker
set search_path = public
as $$
  -- A signed client with nowhere to log in. This is money already won leaking
  -- out through a step nobody owns, which is why it is the one urgent lead rule.
  select
    'won_no_account'::text,
    'won_no_account:' || l.id::text,
    'urgent'::text,
    coalesce(nullif(l.company, ''), l.name, 'Unnamed lead'),
    jsonb_build_object(
      'lead_id', l.id,
      'value', l.value,
      'hours', floor(extract(epoch from (now() - l.updated_at)) / 3600)
    )
  from public.leads l
  where l.stage = 'closed_won'
    and l.hq_company_id is null
    and l.updated_at < now() - interval '24 hours'

  union all

  -- A follow-up the rep set themselves and then missed. Their own promise, so
  -- it needs no interpretation - but it is routine, so it never rings urgent.
  select
    'followup_overdue'::text,
    'followup_overdue:' || l.id::text,
    'notable'::text,
    coalesce(nullif(l.company, ''), l.name, 'Unnamed lead'),
    jsonb_build_object(
      'lead_id', l.id,
      'due', l.next_followup,
      'stage', l.stage
    )
  from public.leads l
  where l.next_followup is not null
    and l.next_followup < now() - interval '2 hours'
    and l.stage not in ('closed_won', 'closed_lost')

  union all

  -- Onboarding stalled past its SLA. Churned and paused clients are excluded:
  -- their steps are meant to be stopped, and alerting on them is how a feed
  -- fills with noise that is all technically true.
  select
    'fulfilment_overdue'::text,
    'fulfilment_overdue:' || c.id::text,
    'notable'::text,
    coalesce(nullif(c.company_name, ''), 'Unnamed client'),
    jsonb_build_object(
      'client_id', c.id,
      'step', c.fulfilment_next_step,
      'due', c.fulfilment_next_due
    )
  from public.clients c
  where c.fulfilment_next_due is not null
    and c.fulfilment_next_due < now()
    and coalesce(c.stage, '') not in ('churned', 'paused')

  union all

  -- Blocked means a human already said this cannot proceed. Someone declaring
  -- themselves stuck and nobody noticing is worth a phone buzzing.
  select
    'fulfilment_blocked'::text,
    'fulfilment_blocked:' || c.id::text,
    'urgent'::text,
    coalesce(nullif(c.company_name, ''), 'Unnamed client'),
    jsonb_build_object(
      'client_id', c.id,
      'blocked', c.fulfilment_blocked_count
    )
  from public.clients c
  where coalesce(c.fulfilment_blocked_count, 0) > 0
    and coalesce(c.stage, '') not in ('churned', 'paused');
$$;

-- ── Fold a scan into the event table ───────────────────────────────────────
-- One transaction, so a scan cannot half-apply: everything currently true is
-- upserted, and anything previously open that this scan did not return is
-- closed. Returning to the queue after being resolved clears notified_at, so a
-- problem that comes back is announced again rather than sitting silently.
create or replace function public.jarvis_apply_scan()
returns integer
language plpgsql
-- INVOKER for the same reason as jarvis_scan: writes land in jarvis_events,
-- which forces RLS and has no policies, so only a BYPASSRLS role can write
-- them. A rep who somehow reached this gets an RLS error, not an audit trail
-- they authored.
security invoker
set search_path = public
as $$
declare
  opened integer;
begin
  create temp table _scan on commit drop as select * from public.jarvis_scan();

  insert into public.jarvis_events (kind, dedup_key, tier, subject, payload)
  select s.kind, s.dedup_key, s.tier, s.subject, s.payload from _scan s
  on conflict (dedup_key) do update
    set last_seen_at = now(),
        tier         = excluded.tier,
        subject      = excluded.subject,
        payload      = excluded.payload,
        notified_at  = case
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

-- ── Locks ──────────────────────────────────────────────────────────────────
-- Internal operational data: which clients are stuck, which deals are leaking.
-- No client and no sales rep has any business reading it. RLS is forced with no
-- policies, the grants are removed, and the SECURITY DEFINER functions are
-- taken off PostgREST - three independent locks, so no single mistake opens it.
alter table public.jarvis_events        enable row level security;
alter table public.jarvis_events        force  row level security;
alter table public.jarvis_notifications enable row level security;
alter table public.jarvis_notifications force  row level security;

do $$
declare t text;
begin
  foreach t in array array['jarvis_events', 'jarvis_notifications'] loop
    execute format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    execute format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    execute format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
    -- service_role keeps its grant: the jarvis-notify function is the only way
    -- in, and it bypasses RLS by design.
    execute format('GRANT ALL ON TABLE public.%I TO service_role', t);
  end loop;
end $$;

-- SECURITY DEFINER functions are exposed by PostgREST as RPCs unless the
-- EXECUTE grant is taken away, which would hand any logged-in rep the whole
-- scan through /rest/v1/rpc.
revoke all on function public.jarvis_scan()       from public, anon, authenticated;
revoke all on function public.jarvis_apply_scan() from public, anon, authenticated;
grant execute on function public.jarvis_scan()       to service_role;
grant execute on function public.jarvis_apply_scan() to service_role;
