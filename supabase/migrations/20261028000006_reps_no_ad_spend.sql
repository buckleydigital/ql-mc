-- Sales reps see the sales metrics for their own leads, never ad spend. The
-- page hides it from them; the database refuses it too: pipeline_spend
-- answers only for non-reps, and ad_spend_daily (readable by any login until
-- now) is closed to reps with a restrictive policy.
create or replace function public.pipeline_spend(p_from date default null, p_to date default null)
returns table (spend numeric, leads_total bigint, spend_updated date)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if is_sales_rep() then
    raise exception 'Not allowed';
  end if;
  return query
  with bounds as (
    select coalesce(p_from, date '2000-01-01') as f, coalesce(p_to, current_date) as t
  ),
  years as (
    select distinct extract(year from a.date)::int as y from ad_spend_daily a, bounds
     where a.account_type = 'agency' and a.date <= bounds.t
       and a.date >= make_date(extract(year from bounds.f)::int, 1, 1)
  ),
  per_year as (
    select years.y,
      coalesce((select a.spend from ad_spend_daily a, bounds b
                 where a.account_type = 'agency' and a.date <= least(b.t, make_date(years.y, 12, 31))
                   and a.date >= make_date(years.y, 1, 1)
                 order by a.date desc limit 1), 0)
      - coalesce((select a.spend from ad_spend_daily a, bounds b
                   where a.account_type = 'agency' and a.date < b.f
                     and a.date >= make_date(years.y, 1, 1)
                   order by a.date desc limit 1), 0) as s
    from years
  )
  select
    coalesce((select sum(greatest(per_year.s, 0)) from per_year), 0)::numeric,
    (select count(*) from leads l, bounds b where l.created_at::date between b.f and b.t),
    (select max(a.date) from ad_spend_daily a where a.account_type = 'agency');
end $$;
revoke all on function public.pipeline_spend(date, date) from public, anon;
grant execute on function public.pipeline_spend(date, date) to authenticated;

drop policy if exists no_sales_rep_ad_spend on public.ad_spend_daily;
create policy no_sales_rep_ad_spend on public.ad_spend_daily as restrictive
  for all to authenticated using (not is_sales_rep()) with check (not is_sales_rep());
