-- Ad spend logged per day, not just as a running total for the year.
--
-- ad_spend_daily.spend (agency rows) has always been the cumulative spend for
-- the year to that date, sent each evening by a Make scenario. A period's
-- spend was one total minus another, so a missed evening or a stuck figure
-- hid inside the difference. day_spend is what was spent on that day alone.
--
-- agency-spend-sync fills it straight from Meta each morning: every day of the
-- last week (zero days included, so there are no gaps), and every day since
-- 1 January on its first run. It also rewrites the running total from those
-- days, so Financials and Jarvis, which read the total, agree with it.
-- A row that arrives with only a total (Make) gets its day worked out from
-- the day before by the trigger below.

alter table public.ad_spend_daily add column if not exists day_spend numeric;

alter table public.business_settings
  add column if not exists agency_ad_account_id text,
  add column if not exists agency_spend_synced_at timestamptz,
  add column if not exists agency_spend_error text;

-- A total with no day: the day is this total less the previous one this year.
create or replace function public.ad_spend_fill_day()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.account_type = 'agency' and new.day_spend is null and new.spend is not null then
    new.day_spend := greatest(0, new.spend - coalesce((
      select a.spend from public.ad_spend_daily a
       where a.account_type = 'agency' and a.date < new.date
         and a.date >= date_trunc('year', new.date)::date
       order by a.date desc limit 1), 0));
  end if;
  return new;
end $$;

create or replace trigger ad_spend_fill_day
  before insert or update of spend on public.ad_spend_daily
  for each row execute function public.ad_spend_fill_day();

-- Every existing row, the same way (the sync replaces these with Meta's own
-- daily figures on its first run).
update public.ad_spend_daily a
   set day_spend = greatest(0, a.spend - coalesce((
         select p.spend from public.ad_spend_daily p
          where p.account_type = 'agency' and p.date < a.date
            and p.date >= date_trunc('year', a.date)::date
          order by p.date desc limit 1), 0))
 where a.account_type = 'agency' and a.day_spend is null;

-- What agency-spend-sync writes: [{date, spend}] for each day it asked Meta
-- about, from p_from to p_to. Days Meta didn't return are zero. Then the
-- running total for the year is rebuilt from the days.
create or replace function public.agency_spend_apply(p_from date, p_to date, p_days jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.ad_spend_daily (date, account_type, day_spend, spend, leads)
  select d::date, 'agency',
         coalesce((select (x ->> 'spend')::numeric from jsonb_array_elements(p_days) x where (x ->> 'date')::date = d::date), 0),
         0, 0
    from generate_series(p_from, p_to, interval '1 day') d
  on conflict (date, account_type) do update set day_spend = excluded.day_spend;
  get diagnostics n = row_count;

  -- The running total, per year, from the days.
  update public.ad_spend_daily a set spend = r.cum
    from (select id, sum(day_spend) over (partition by extract(year from date) order by date) cum
            from public.ad_spend_daily where account_type = 'agency') r
   where a.id = r.id and a.spend is distinct from r.cum;
  return n;
end $$;
revoke all on function public.agency_spend_apply(date, date, jsonb) from public, anon, authenticated;
grant execute on function public.agency_spend_apply(date, date, jsonb) to service_role;

-- Spend over a period is now the days in it added up.
create or replace function public.pipeline_spend(p_from date default null, p_to date default null)
returns table(spend numeric, leads_total bigint, spend_updated date)
language plpgsql stable security definer set search_path = public as $$
begin
  if is_sales_rep() then
    raise exception 'Not allowed';
  end if;
  return query
  select
    coalesce((select sum(a.day_spend) from ad_spend_daily a
               where a.account_type = 'agency'
                 and a.date between coalesce(p_from, date '2000-01-01') and coalesce(p_to, current_date)), 0)::numeric,
    (select count(*) from leads l where l.created_at::date between coalesce(p_from, date '2000-01-01') and coalesce(p_to, current_date)),
    (select max(a.date) from ad_spend_daily a where a.account_type = 'agency');
end $$;

-- Each morning at 7:05 Sydney (summer; 6:05 in winter), before the guardrail
-- snapshot at 7:45: yesterday's spend is final by then.
select cron.schedule('agency-spend-sync', '5 20 * * *', $job$
  select net.http_post(
    url := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/agency-spend-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
  where exists (select 1 from public.business_settings where coalesce(agency_ad_account_id, '') <> '');
$job$);
