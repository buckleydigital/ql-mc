-- Guardrails: the business metrics that decide whether to scale, each with a
-- warning and a breach line, an owner and an action. Read on the Scoreboard,
-- and raised through Jarvis (panel note, text, and a call for a breach if
-- calls are on) like every other alert.
--
--   Daily digest: a snapshot is taken each morning (guardrail_take_snapshot,
--   pg_cron) and anything amber or red in it is raised once that day.
--   Real time: speed-to-lead (per uncontacted lead) and spend pacing are
--   checked every heartbeat.
--   Weekly review: each Monday, the scale signal and the latest cohort CAC.
--
-- Thresholds, owners and actions have defaults here; any of them can be
-- changed on the Scoreboard (business_settings.guardrails holds only what was
-- changed, so a better default later reaches everything not customised).

alter table public.business_settings
  add column if not exists guardrails jsonb not null default '{}'::jsonb,
  add column if not exists va_load jsonb,
  add column if not exists va_load_synced_at timestamptz;

create table if not exists public.guardrail_snapshots (
  day date primary key,
  metrics jsonb not null,
  signal text not null,
  created_at timestamptz not null default now()
);
alter table public.guardrail_snapshots enable row level security;
alter table public.guardrail_snapshots force row level security;
revoke all on public.guardrail_snapshots from anon, authenticated;

-- ── Defaults ─────────────────────────────────────────────────────────────────
-- dir: 'high' = higher is worse, 'low' = lower is worse. green is shown, not
-- alerted on. A null breach means warning only.
create or replace function public.guardrail_defaults()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'plan_daily_spend', null,
    'plan_weekly_leads', null,
    'metrics', jsonb_build_object(
      'cpl', jsonb_build_object('on', true, 'label', 'CPL (7-day)', 'dir', 'high', 'unit', '$', 'green', 40, 'warn', 48, 'breach', 60,
        'owner', 'Media buyer', 'action', 'Check creative fatigue and pause the worst ad set within 24h.'),
      'pitch_rate', jsonb_build_object('on', true, 'label', 'Pitch rate', 'dir', 'low', 'unit', '%', 'green', 45, 'warn', 42, 'breach', 35,
        'owner', 'Sales', 'action', 'Review call recordings and the opener; check the latest leads are the right people.'),
      'pitch_to_close', jsonb_build_object('on', true, 'label', 'Pitch-to-close', 'dir', 'low', 'unit', '%', 'green', 35, 'warn', 35, 'breach', 30,
        'owner', 'Sales', 'action', 'Go through this month''s lost offers; tighten the offer and the follow-up.'),
      'speed_to_lead', jsonb_build_object('on', true, 'label', 'Speed-to-lead', 'dir', 'high', 'unit', 'min', 'green', 5, 'warn', 5, 'breach', 15,
        'owner', 'Sales', 'action', 'Call new leads now; check who is on the phones.'),
      'spend_pacing', jsonb_build_object('on', true, 'label', 'Spend vs plan', 'dir', 'high', 'unit', '%', 'green', 10, 'warn', 20, 'breach', 35,
        'owner', 'Media buyer', 'action', 'Check budgets and any campaign overspending today.'),
      'lead_volume', jsonb_build_object('on', true, 'label', 'Lead volume vs plan (7-day)', 'dir', 'high', 'unit', '% below', 'green', 10, 'warn', 20, 'breach', null,
        'owner', 'Media buyer', 'action', 'Check delivery, budgets, and whether any ads were paused or rejected.'),
      'clients_per_va', jsonb_build_object('on', true, 'label', 'Active clients per VA', 'dir', 'high', 'unit', '', 'green', 20, 'warn', 25, 'breach', 30,
        'owner', 'Ops', 'action', 'Hire or rebalance before taking on more clients.'),
      'no_show', jsonb_build_object('on', true, 'label', 'No-show rate (30-day)', 'dir', 'high', 'unit', '%', 'green', 20, 'warn', 30, 'breach', 40,
        'owner', 'Sales', 'action', 'Confirm every booking by text the day before and on the day.'),
      'cohort_cac', jsonb_build_object('on', true, 'label', 'Day-21 cohort CAC', 'dir', 'high', 'unit', '$', 'green', 350, 'warn', 400, 'breach', 500,
        'owner', 'Owner', 'action', 'Hold spend and fix the funnel. Two cohorts trending up: pause scaling.'),
      'collection', jsonb_build_object('on', true, 'label', 'Cash collected vs booked', 'dir', 'low', 'unit', '%', 'green', 95, 'warn', 90, 'breach', 75,
        'owner', 'Accounts', 'action', 'Chase overdue retainers before spending more on ads.'),
      'churn_spike', jsonb_build_object('on', true, 'label', '30-day churn vs baseline', 'dir', 'high', 'unit', '% over', 'green', 0, 'warn', 20, 'breach', null,
        'owner', 'Ops', 'action', 'Review churned clients'' results and call at-risk clients this week.'),
      'followup_sla', jsonb_build_object('on', true, 'label', 'Leads with no touch in 24h', 'dir', 'high', 'unit', '', 'green', 0, 'warn', 1, 'breach', 5,
        'owner', 'Sales', 'action', 'Touch every lead listed today.')
    )
  )
$$;

-- Defaults with the business's changes laid over them, per metric.
create or replace function public.guardrail_settings()
returns jsonb language sql stable security definer set search_path = public as $$
  with d as (select public.guardrail_defaults() j),
       o as (select coalesce((select guardrails from public.business_settings limit 1), '{}'::jsonb) j)
  select jsonb_build_object(
    'plan_daily_spend', coalesce(o.j -> 'plan_daily_spend', d.j -> 'plan_daily_spend'),
    'plan_weekly_leads', coalesce(o.j -> 'plan_weekly_leads', d.j -> 'plan_weekly_leads'),
    'metrics', (select jsonb_object_agg(k, v || coalesce(o.j -> 'metrics' -> k, '{}'::jsonb))
                  from jsonb_each(d.j -> 'metrics') as m(k, v)))
  from d, o
$$;

-- ── Touches ─────────────────────────────────────────────────────────────────
-- The first time anyone reached out to a lead: a stage move off New Lead, a
-- text or email sent, or a logged call. Automated no-answer follow-ups don't
-- count; they only start once someone has already tried calling.
create or replace function public.lead_first_touch(p_lead uuid)
returns timestamptz language sql stable set search_path = public as $$
  select least(
    (select min(changed_at) from public.lead_stage_history where lead_id = p_lead and from_stage = 'new_lead'),
    (select min(created_at) from public.sales_sms_log where lead_id = p_lead and direction = 'outbound'),
    (select min(sent_at) from public.sales_email_log where lead_id = p_lead and kind <> 'no_answer'),
    (select min(contacted_at) from public.lead_contact_log where lead_id = p_lead))
$$;

-- The last time anything happened with a lead, either way.
create or replace function public.lead_last_touch(p_lead uuid)
returns timestamptz language sql stable set search_path = public as $$
  select greatest(l.created_at, l.stage_changed_at, l.last_contact, l.followup_sent_at, l.info_sent_at, l.info_5k_sent_at, l.offer_sent_at,
    (select max(created_at) from public.sales_sms_log where lead_id = l.id),
    (select max(sent_at) from public.sales_email_log where lead_id = l.id),
    (select max(contacted_at) from public.lead_contact_log where lead_id = l.id))
  from public.leads l where l.id = p_lead
$$;

-- ── Grading ─────────────────────────────────────────────────────────────────
create or replace function public.guardrail_level(p_value numeric, p_cfg jsonb)
returns text language sql immutable as $$
  select case
    when p_value is null then 'no_data'
    when (p_cfg ->> 'dir') = 'low' then
      case when nullif(p_cfg ->> 'breach', '') is not null and p_value < (p_cfg ->> 'breach')::numeric then 'breach'
           when nullif(p_cfg ->> 'warn', '') is not null and p_value < (p_cfg ->> 'warn')::numeric then 'warning'
           when nullif(p_cfg ->> 'green', '') is not null and p_value < (p_cfg ->> 'green')::numeric then 'watch'
           else 'green' end
    else
      case when nullif(p_cfg ->> 'breach', '') is not null and p_value > (p_cfg ->> 'breach')::numeric then 'breach'
           when nullif(p_cfg ->> 'warn', '') is not null and p_value > (p_cfg ->> 'warn')::numeric then 'warning'
           when nullif(p_cfg ->> 'green', '') is not null and p_value > (p_cfg ->> 'green')::numeric then 'watch'
           else 'green' end
  end
$$;

-- Spend over a range, or null when the ad spend feed hasn't reached its end.
create or replace function public.guardrail_spend(p_from date, p_to date)
returns numeric language sql stable security definer set search_path = public as $$
  select case when s.spend_updated is null or s.spend_updated < p_to then null else s.spend end
  from public.pipeline_spend(p_from, p_to) s
$$;

-- ── The metrics ─────────────────────────────────────────────────────────────
-- One row per metric: value, level, and the words for the panel and the text.
create or replace function public.guardrail_metrics()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  tz constant text := 'Australia/Sydney';
  today date := (now() at time zone tz)::date;
  cfg jsonb := public.guardrail_settings();
  m jsonb := cfg -> 'metrics';
  out jsonb := '[]'::jsonb;
  v numeric; n numeric; d numeric; sp numeric; detail text;
  plan numeric;
  last_spend date := (select max(date) from public.ad_spend_daily where account_type = 'agency');
  stale text := 'Ad spend has not updated since ' || coalesce(to_char((select max(date) from public.ad_spend_daily where account_type = 'agency'), 'DD Mon'), 'ever') || '.';
  cohorts jsonb := '[]'::jsonb;
  elig jsonb;
  c1 numeric; c2 numeric; c3 numeric; trending boolean := false;
  r record;
begin
  -- CPL, 7-day rolling.
  sp := public.guardrail_spend(today - 7, today - 1);
  select count(*) into n from public.leads where (created_at at time zone tz)::date between today - 7 and today - 1;
  v := case when sp is null then null when n > 0 then round(sp / n, 2) when sp > 0 then 999999 else null end;
  detail := case when sp is null then stale
                 when n = 0 and sp > 0 then '$' || round(sp) || ' spent, no leads in 7 days.'
                 when n = 0 then 'No spend or leads in the last 7 days.'
                 else '$' || round(sp) || ' over ' || n || ' leads, last 7 days.' end;
  out := out || jsonb_build_object('key', 'cpl', 'value', v, 'display', case when v >= 999999 then 'no leads' when v is null then '-' else '$' || to_char(v, 'FM999990.00') end, 'detail', detail, 'sample', n);

  -- Pitch rate: leads that came in 3 to 9 days ago (time to be pitched) that got an offer.
  select count(*), count(*) filter (where offer_sent_at is not null) into n, d
    from public.leads where (created_at at time zone tz)::date between today - 9 and today - 3;
  v := case when n >= 5 then round(d * 100 / n, 1) end;
  out := out || jsonb_build_object('key', 'pitch_rate', 'value', v, 'display', coalesce(v || '%', '-'), 'sample', n,
    'detail', case when n < 5 then 'Only ' || n || ' leads came in 3 to 9 days ago; needs 5 to judge.' else d || ' of ' || n || ' leads from 3 to 9 days ago were sent an offer.' end);

  -- Pitch-to-close: offers sent 8 to 37 days ago that have been won.
  select count(*), count(*) filter (where won_at is not null) into n, d
    from public.leads where offer_sent_at is not null and (offer_sent_at at time zone tz)::date between today - 37 and today - 8;
  v := case when n >= 5 then round(d * 100 / n, 1) end;
  out := out || jsonb_build_object('key', 'pitch_to_close', 'value', v, 'display', coalesce(v || '%', '-'), 'sample', n,
    'detail', case when n < 5 then 'Only ' || n || ' offers sent 8 to 37 days ago; needs 5 to judge.' else d || ' of ' || n || ' offers sent 8 to 37 days ago closed.' end);

  -- Speed-to-lead: median minutes to first touch, inbound leads in the last 7
  -- days that came in between 7am and 8pm (a lead at 2am isn't late at 7).
  select count(*), percentile_cont(0.5) within group (order by mins) into n, v from (
    select extract(epoch from (coalesce(public.lead_first_touch(l.id), now()) - l.created_at)) / 60 as mins
      from public.leads l
     where l.created_at > now() - interval '7 days' and l.created_at < now() - interval '15 minutes'
       and coalesce(l.source, '') <> 'outbound'
       and extract(hour from l.created_at at time zone tz) between 7 and 19) x;
  v := case when n > 0 then round(greatest(v, 0), 1) end;
  out := out || jsonb_build_object('key', 'speed_to_lead', 'value', v, 'display', coalesce(v || ' min', '-'), 'sample', n, 'realtime', true,
    'detail', case when n = 0 then 'No inbound leads in business hours in the last 7 days.' else 'Median over ' || n || ' inbound leads, last 7 days (7am to 8pm).' end);

  -- Spend pacing: yesterday's (or today's so far) spend against the daily plan.
  plan := nullif(cfg ->> 'plan_daily_spend', '')::numeric;
  sp := greatest(public.guardrail_spend(today - 1, today - 1), case when last_spend >= today then public.guardrail_spend(today, today) end);
  v := case when plan > 0 and sp is not null then round((sp / plan - 1) * 100, 1) end;
  out := out || jsonb_build_object('key', 'spend_pacing', 'value', v, 'realtime', true,
    'display', case when v is null then '-' else case when v >= 0 then '+' else '' end || v || '%' end,
    'detail', case when coalesce(plan, 0) <= 0 then 'Set a daily spend plan to check pacing.'
                   when sp is null then stale
                   else '$' || round(sp) || ' a day against a plan of $' || round(plan) || '.' end);

  -- Lead volume: last 7 days against the weekly plan.
  plan := nullif(cfg ->> 'plan_weekly_leads', '')::numeric;
  select count(*) into n from public.leads where (created_at at time zone tz)::date between today - 7 and today - 1;
  v := case when plan > 0 then round(greatest(0, (1 - n / plan) * 100), 1) end;
  out := out || jsonb_build_object('key', 'lead_volume', 'value', v, 'sample', n,
    'display', case when v is null then n || ' leads' else n || ' / ' || round(plan) end,
    'detail', case when coalesce(plan, 0) <= 0 then 'Set a weekly lead plan to check volume.' else n || ' leads in 7 days against a plan of ' || round(plan) || '.' end);

  -- Active clients per fulfilment VA, from HQ's assignments.
  select max(cnt), string_agg(name || ' ' || cnt, ', ' order by cnt desc) into v, detail from (
    select coalesce(nullif(va ->> 'name', ''), 'Unnamed VA') as name,
           (select count(*) from public.clients c
             where c.type = 'managed' and c.stage in ('active', 'onboarding')
               and c.ql_hq_company_id in (select jsonb_array_elements_text(va -> 'company_ids'))) as cnt
      from jsonb_array_elements(coalesce((select va_load from public.business_settings
                                            where va_load_synced_at > now() - interval '2 days' limit 1), '[]'::jsonb)) va) x;
  out := out || jsonb_build_object('key', 'clients_per_va', 'value', v, 'display', coalesce(v::text, '-'),
    'detail', coalesce(detail, 'Waiting for VA assignments from HQ.'));

  -- No-shows: of leads booked (moved to Call-Back/Booked) in the last 30 days,
  -- those moved back to No Answer or New Lead afterwards.
  select count(*), count(*) filter (where exists (
           select 1 from public.lead_stage_history h2 where h2.lead_id = b.lead_id and h2.from_stage = 'call_back'
              and h2.to_stage in ('no_answer', 'new_lead') and h2.changed_at > b.booked)) into n, d
    from (select lead_id, min(changed_at) booked from public.lead_stage_history
           where to_stage = 'call_back' and changed_at > now() - interval '30 days' group by lead_id) b;
  v := case when n >= 5 then round(d * 100 / n, 1) end;
  out := out || jsonb_build_object('key', 'no_show', 'value', v, 'display', coalesce(v || '%', '-'), 'sample', n,
    'detail', case when n < 5 then 'Only ' || n || ' bookings in 30 days; needs 5 to judge. A booked lead moved back to No Answer counts as a no-show.'
                   else d || ' of ' || n || ' bookings fell through (moved back to No Answer or New Lead).' end);

  -- Day-21 cohort CAC: each week's leads, judged 21 days after the week ends,
  -- the week's ad spend over the sales won within 21 days of coming in.
  for r in
    select gs::date ws from generate_series(date_trunc('week', today - 27 - 7 * 9)::date, (today - 27)::date, interval '7 days') gs
     where gs::date + 6 <= today - 21 order by gs desc limit 8
  loop
    sp := public.guardrail_spend(r.ws, r.ws + 6);
    select count(*), count(*) filter (where won_at is not null and won_at <= created_at + interval '21 days') into n, d
      from public.leads where (created_at at time zone tz)::date between r.ws and r.ws + 6;
    cohorts := cohorts || jsonb_build_object('week', r.ws, 'spend', sp, 'leads', n, 'sales', d,
      'cac', case when sp is not null and d > 0 then round(sp / d, 2) end);
  end loop;
  -- Judged on weeks with at least 5 leads: one sale more or less in a
  -- three-lead week swings CAC from fine to infinite. Newest first. Two rises
  -- in a row across the last three: pause scaling.
  elig := (select coalesce(jsonb_agg(e order by o), '[]'::jsonb)
             from jsonb_array_elements(cohorts) with ordinality as x(e, o) where (e ->> 'leads')::int >= 5);
  c1 := nullif(elig -> 0 ->> 'cac', '')::numeric;
  c2 := nullif(elig -> 1 ->> 'cac', '')::numeric;
  c3 := nullif(elig -> 2 ->> 'cac', '')::numeric;
  trending := coalesce(c1 > c2 and c2 > c3, false);
  v := case when (elig -> 0 ->> 'spend') is null then null
            when c1 is not null then c1
            when (elig -> 0 ->> 'spend')::numeric > 0 then 999999 end;
  out := out || jsonb_build_object('key', 'cohort_cac', 'value', v, 'cohorts', cohorts, 'trending_up', trending,
    'display', case when v >= 999999 then 'no sales' when v is null then '-' else '$' || round(v) end,
    'detail', case when elig -> 0 is null then 'No week with 5+ leads is 21 days old yet.'
                   when (elig -> 0 ->> 'spend') is null then stale
                   else 'Week of ' || to_char((elig -> 0 ->> 'week')::date, 'DD Mon') || ': $' || round((elig -> 0 ->> 'spend')::numeric) || ' spend, '
                        || (elig -> 0 ->> 'sales') || ' of ' || (elig -> 0 ->> 'leads') || ' leads won within 21 days.'
                        || case when trending then ' Two cohorts in a row trending up: pause scaling.' else '' end end);

  -- Cash collected vs booked: the share of active managed retainers that is
  -- paid up (not more than 3 days past the payment date).
  select sum(management_fee), sum(management_fee) filter (where next_payment_date < today - 3),
         string_agg(company_name, ', ') filter (where next_payment_date < today - 3)
    into n, d, detail
    from public.clients where type = 'managed' and stage = 'active' and coalesce(management_fee, 0) > 0;
  v := case when n > 0 then round((1 - coalesce(d, 0) / n) * 100, 1) end;
  out := out || jsonb_build_object('key', 'collection', 'value', v, 'display', coalesce(v || '%', '-'),
    'detail', case when coalesce(n, 0) = 0 then 'No active retainers.'
                   when coalesce(d, 0) = 0 then 'Every active retainer is paid up ($' || round(n) || ' a month).'
                   else '$' || round(d) || ' of $' || round(n) || ' a month overdue: ' || detail || '.' end);

  -- Churn spike: clients lost in the last 30 days over those active 30 days
  -- ago, against the average of the six 30-day periods before.
  select
    (select count(*) from public.clients where churned_at > today - 30 and churned_at <= today),
    (select count(*) from public.clients where client_since <= today - 30 and (churned_at is null or churned_at > today - 30)),
    (select avg(case when s.base > 0 then s.lost::numeric / s.base end) from (
       select (select count(*) from public.clients c where c.churned_at > today - 30 * (k + 1) and c.churned_at <= today - 30 * k) lost,
              (select count(*) from public.clients c where c.client_since <= today - 30 * (k + 1) and (c.churned_at is null or c.churned_at > today - 30 * (k + 1))) base
         from generate_series(1, 6) k) s)
    into d, n, sp;
  v := case when n > 0 and sp is not null then
         case when sp > 0 then round(((d / n) / sp - 1) * 100, 1) when d > 0 then 100 else 0 end end;
  out := out || jsonb_build_object('key', 'churn_spike', 'value', case when d = 0 then least(v, 0) else v end,
    'display', case when n > 0 then round(d * 100 / n, 1) || '%' else '-' end,
    'detail', case when coalesce(n, 0) = 0 then 'No clients active 30 days ago.'
                   else d || ' of ' || n || ' clients lost in 30 days (' || round(d * 100 / n, 1) || '%); usual is '
                        || coalesce(round(sp * 100, 1) || '%', 'unknown') || '.' end);

  -- Follow-up SLA: open leads nobody has touched in 24 hours. No Answer
  -- leads are on the automatic follow-up sequence, so they aren't counted.
  select count(*), string_agg(nm, ', ' order by t) filter (where rn <= 5) into n, detail from (
    select coalesce(nullif(l.company, ''), l.name, 'Unnamed') nm, t.t, row_number() over (order by t.t) rn
      from public.leads l cross join lateral (select public.lead_last_touch(l.id) t) t
     where l.stage in ('new_lead', 'call_back', 'proposal') and t.t < now() - interval '24 hours') x;
  out := out || jsonb_build_object('key', 'followup_sla', 'value', n, 'display', n::text,
    'detail', case when n = 0 then 'Every open lead has been touched in the last day.'
                   else 'Oldest first: ' || detail || case when n > 5 then ' and ' || (n - 5) || ' more' else '' end || '.' end);

  -- Grade each against its settings.
  return (
    select jsonb_agg(x || jsonb_build_object(
             'label', c ->> 'label', 'owner', c ->> 'owner', 'action', c ->> 'action',
             'unit', c ->> 'unit', 'dir', c ->> 'dir', 'green', c -> 'green', 'warn', c -> 'warn', 'breach', c -> 'breach',
             'on', coalesce((c ->> 'on')::boolean, true),
             'level', case when not coalesce((c ->> 'on')::boolean, true) then 'off'
                           when x ->> 'key' = 'cohort_cac' and coalesce((x ->> 'trending_up')::boolean, false) then 'breach'
                           else public.guardrail_level(nullif(x ->> 'value', '')::numeric, c) end)
           order by o)
      from jsonb_array_elements(out) with ordinality as e(x, o)
      cross join lateral (select m -> (x ->> 'key') as c) cc);
end $$;

-- Green: scale 20 to 25%. Amber: hold spend and fix. Red: pause scaling.
create or replace function public.guardrail_signal(p_metrics jsonb)
returns text language sql immutable as $$
  select case
    when exists (select 1 from jsonb_array_elements(p_metrics) e where e ->> 'level' = 'breach') then 'red'
    when exists (select 1 from jsonb_array_elements(p_metrics) e where e ->> 'level' = 'warning') then 'amber'
    else 'green' end
$$;

-- The morning snapshot. The first run of the day wins, so the digest says the
-- same thing all day; p_force retakes it (the Scoreboard's refresh).
create or replace function public.guardrail_take_snapshot(p_force boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  mx jsonb := public.guardrail_metrics();
begin
  insert into public.guardrail_snapshots (day, metrics, signal)
  values (today, mx, public.guardrail_signal(mx))
  on conflict (day) do update set metrics = excluded.metrics, signal = excluded.signal, created_at = now()
    where p_force;
end $$;

-- For the Scoreboard: live values, this morning's snapshot, the settings and
-- the defaults. Not for reps.
create or replace function public.guardrail_report(p_refresh boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare mx jsonb;
begin
  perform public.jarvis_assert_operator();
  if p_refresh then perform public.guardrail_take_snapshot(true); end if;
  mx := public.guardrail_metrics();
  return jsonb_build_object(
    'metrics', mx,
    'signal', public.guardrail_signal(mx),
    'snapshot', (select jsonb_build_object('day', day, 'signal', signal, 'at', created_at) from public.guardrail_snapshots order by day desc limit 1),
    'settings', public.guardrail_settings(),
    'defaults', public.guardrail_defaults(),
    'va_synced_at', (select va_load_synced_at from public.business_settings limit 1));
end $$;

-- ── Into Jarvis ─────────────────────────────────────────────────────────────
-- Events for jarvis_scan. Daily metrics come from today's snapshot, keyed by
-- the day, so each amber or red line is raised once a morning. Spend pacing
-- and each uncontacted lead are live.
create or replace function public.guardrail_scan()
returns table(kind text, dedup_key text, tier text, subject text, payload jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  tz constant text := 'Australia/Sydney';
  today date := (now() at time zone tz)::date;
  snap record;
  cfg jsonb := public.guardrail_settings() -> 'metrics';
  sw numeric := coalesce(nullif(cfg -> 'speed_to_lead' ->> 'warn', '')::numeric, 5);
  sb numeric := coalesce(nullif(cfg -> 'speed_to_lead' ->> 'breach', '')::numeric, 15);
begin
  select * into snap from public.guardrail_snapshots where day = today;
  if found then
    return query
      select 'guardrail'::text,
             'guardrail:' || (e ->> 'key') || ':' || (e ->> 'level') || ':' || today,
             case when e ->> 'level' = 'breach' then 'urgent' else 'notable' end,
             e ->> 'label',
             e || jsonb_build_object('day', today)
        from jsonb_array_elements(snap.metrics) e
       where e ->> 'level' in ('warning', 'breach')
         and coalesce((e ->> 'realtime')::boolean, false) = false;

    -- Monday: the weekly review.
    if extract(isodow from today) = 1 then
      return query
        select 'guardrail_weekly'::text, 'guardrail_weekly:' || today, 'notable'::text, 'Weekly review',
               jsonb_build_object('signal', snap.signal,
                 'cac', (select e ->> 'display' from jsonb_array_elements(snap.metrics) e where e ->> 'key' = 'cohort_cac'),
                 'trending_up', (select (e ->> 'trending_up')::boolean from jsonb_array_elements(snap.metrics) e where e ->> 'key' = 'cohort_cac'),
                 'red', (select count(*) from jsonb_array_elements(snap.metrics) e where e ->> 'level' = 'breach'),
                 'amber', (select count(*) from jsonb_array_elements(snap.metrics) e where e ->> 'level' = 'warning'));
    end if;
  end if;

  -- Spend pacing, live.
  return query
    select 'guardrail'::text,
           'guardrail:spend_pacing:' || (e ->> 'level') || ':' || today,
           case when e ->> 'level' = 'breach' then 'urgent' else 'notable' end,
           e ->> 'label', e || jsonb_build_object('day', today)
      from jsonb_array_elements(public.guardrail_metrics()) e
     where e ->> 'key' = 'spend_pacing' and e ->> 'level' in ('warning', 'breach');

  -- Speed-to-lead, live: each inbound lead in the last 12 hours still in New
  -- Lead with no touch, once at the warning line and again at the breach.
  if coalesce((cfg -> 'speed_to_lead' ->> 'on')::boolean, true) then
    return query
      select 'speed_to_lead'::text,
             'speed_to_lead:' || l.id || ':' || case when a.mins > sb then 'breach' else 'warning' end,
             case when a.mins > sb then 'urgent' else 'notable' end,
             coalesce(nullif(l.company, ''), l.name, 'New lead'),
             jsonb_build_object('lead_id', l.id, 'minutes', floor(a.mins), 'phone', l.phone,
               'owner', cfg -> 'speed_to_lead' ->> 'owner', 'action', cfg -> 'speed_to_lead' ->> 'action')
        from public.leads l
        cross join lateral (select extract(epoch from (now() - l.created_at)) / 60 as mins) a
       where l.created_at > now() - interval '12 hours'
         and coalesce(l.source, '') <> 'outbound'
         and coalesce(l.stage, 'new_lead') = 'new_lead'
         and a.mins > sw
         and public.lead_first_touch(l.id) is null;
  end if;
end $$;

create or replace function public.jarvis_scan()
returns table(kind text, dedup_key text, tier text, subject text, payload jsonb)
language sql stable set search_path = public as $$
  select * from public.jarvis_scan_base()
  union all
  select a.kind, a.dedup_key, a.tier, a.subject, a.payload from public.managed_alerts a where a.active
  union all
  select * from public.guardrail_scan()
$$;

revoke all on function public.guardrail_metrics() from public, anon, authenticated;
revoke all on function public.guardrail_scan() from public, anon, authenticated;
revoke all on function public.guardrail_take_snapshot(boolean) from public, anon, authenticated;
revoke all on function public.guardrail_spend(date, date) from public, anon, authenticated;
revoke all on function public.guardrail_settings() from public, anon, authenticated;
grant execute on function public.guardrail_report(boolean) to authenticated;

-- Each morning, before quiet hours end: 7:45 Sydney in summer, 6:45 in winter.
select cron.schedule('guardrail-snapshot', '45 20 * * *', $job$ select public.guardrail_take_snapshot(false) $job$);

-- jarvis_scan runs as the service role (jarvis-notify).
grant execute on function public.guardrail_scan(), public.guardrail_metrics(), public.guardrail_take_snapshot(boolean),
  public.guardrail_settings(), public.guardrail_spend(date, date) to service_role;
