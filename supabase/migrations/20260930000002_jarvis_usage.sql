-- What Jarvis costs.
--
-- One row per question he answers (or fails to), written by jarvis-chat and by
-- jarvis-reply's no-tools SMS fallback. The raw token counts are kept alongside
-- the dollar figure so the cost can be recomputed if prices change - cost_usd
-- is what it cost at list price on the day, not a number to trust forever.
--
-- Anthropic API spend only. Twilio texts and calls are billed separately and
-- are not in here.

create table if not exists public.jarvis_usage (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  -- panel, sms, or sms-fallback (the no-tools answer in jarvis-reply).
  channel             text        not null,
  user_id             uuid,
  -- The model(s) that actually served it; a refusal fallback can change it.
  model               text,
  -- 'answered', 'refused', 'too_many_steps', 'error'.
  outcome             text,
  steps               int         not null default 0,
  input_tokens        bigint      not null default 0,
  output_tokens       bigint      not null default 0,
  cache_read_tokens   bigint      not null default 0,
  cache_write_tokens  bigint      not null default 0,
  web_searches        int         not null default 0,
  web_fetches         int         not null default 0,
  cost_usd            numeric(12, 6) not null default 0
);

create index if not exists jarvis_usage_created_idx
  on public.jarvis_usage (created_at desc);

alter table public.jarvis_usage enable row level security;
alter table public.jarvis_usage force  row level security;
revoke all on table public.jarvis_usage from public, anon, authenticated;
grant all  on table public.jarvis_usage to service_role;

-- Totals for the settings panel. Same shape and gate as jarvis_action_log:
-- SECURITY DEFINER over a table the browser cannot read, admitting only the
-- people who run the business. Returns sums, never rows.
create or replace function public.jarvis_usage_summary(p_tz text default 'Australia/Sydney')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  acct  text;
  tz    text;
  today date;
  month_start date;
  last_month_start date;
  result jsonb;
begin
  if auth.jwt() is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  acct := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  if acct in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  -- An unknown zone name would raise; fall back rather than fail the panel.
  tz := case when exists (select 1 from pg_timezone_names where name = p_tz)
             then p_tz else 'Australia/Sydney' end;
  today            := (now() at time zone tz)::date;
  month_start      := date_trunc('month', today)::date;
  last_month_start := (month_start - interval '1 month')::date;

  with u as (
    select (created_at at time zone tz)::date as day, *
    from public.jarvis_usage
    where created_at >= (last_month_start::timestamp at time zone tz)
  ),
  totals as (
    select
      coalesce(sum(cost_usd) filter (where day = today), 0)              as today_cost,
      count(*)               filter (where day = today)                  as today_q,
      coalesce(sum(cost_usd) filter (where day >= month_start), 0)       as month_cost,
      count(*)               filter (where day >= month_start)           as month_q,
      coalesce(sum(web_searches) filter (where day >= month_start), 0)   as month_searches,
      coalesce(sum(cost_usd) filter (where day < month_start), 0)        as last_cost,
      count(*)               filter (where day < month_start)            as last_q
    from u
  ),
  days as (
    select day, sum(cost_usd) as cost, count(*) as questions
    from u where day >= today - 29
    group by day order by day
  )
  select jsonb_build_object(
    'today',      jsonb_build_object('cost_usd', t.today_cost, 'questions', t.today_q),
    'month',      jsonb_build_object('cost_usd', t.month_cost, 'questions', t.month_q,
                                     'web_searches', t.month_searches,
                                     'avg_per_question', case when t.month_q > 0
                                       then round(t.month_cost / t.month_q, 4) else 0 end),
    'last_month', jsonb_build_object('cost_usd', t.last_cost, 'questions', t.last_q),
    'all_time',   (select jsonb_build_object('cost_usd', coalesce(sum(cost_usd), 0),
                                             'questions', count(*),
                                             'since', min(created_at))
                   from public.jarvis_usage),
    'by_day',     coalesce((select jsonb_agg(jsonb_build_object(
                                'day', d.day, 'cost_usd', d.cost, 'questions', d.questions))
                            from days d), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$$;

revoke all on function public.jarvis_usage_summary(text) from public, anon;
grant execute on function public.jarvis_usage_summary(text) to authenticated, service_role;
