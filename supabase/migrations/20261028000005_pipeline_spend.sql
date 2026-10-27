-- Ad spend and lead count for a timeframe, for the Sales Pipeline metrics.
--
-- Spend is the QuoteLeads (agency) ad account. ad_spend_daily stores that
-- account's spend as a running total for the year, so a range's spend is the
-- last total in it less the last total before it, year by year (each year
-- starts again from zero). The lead count is every lead that came in, so a
-- sales rep, who sees only their own leads, can be given their share of the
-- spend: spend × their leads ÷ all leads.
create or replace function public.pipeline_spend(p_from date default null, p_to date default null)
returns table (spend numeric, leads_total bigint, spend_updated date)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select coalesce(p_from, date '2000-01-01') as f, coalesce(p_to, current_date) as t
  ),
  years as (
    select distinct extract(year from date)::int as y from ad_spend_daily, bounds
     where account_type = 'agency' and date <= bounds.t
       and date >= make_date(extract(year from bounds.f)::int, 1, 1)
  ),
  per_year as (
    select y,
      coalesce((select a.spend from ad_spend_daily a, bounds b
                 where a.account_type = 'agency' and a.date <= least(b.t, make_date(y, 12, 31))
                   and a.date >= make_date(y, 1, 1)
                 order by a.date desc limit 1), 0)
      - coalesce((select a.spend from ad_spend_daily a, bounds b
                   where a.account_type = 'agency' and a.date < b.f
                     and a.date >= make_date(y, 1, 1)
                   order by a.date desc limit 1), 0) as s
    from years
  )
  select
    coalesce((select sum(greatest(s, 0)) from per_year), 0)::numeric,
    (select count(*) from leads l, bounds b where l.created_at::date between b.f and b.t),
    (select max(date) from ad_spend_daily where account_type = 'agency');
$$;
revoke all on function public.pipeline_spend(date, date) from public, anon;
grant execute on function public.pipeline_spend(date, date) to authenticated;
