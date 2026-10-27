-- The numbers Jarvis is asked about, computed the way the dashboard computes
-- them, so "what was churn last month" gets the same answer in the panel as
-- on the Clients page.
--
--   churn_by_month(type)            Monthly churn: clients lost in the month ÷
--                                   clients at its start (monthlyChurn in
--                                   index.html).
--   sales_metrics(from, to, owner)  The Scoreboard's 15 sales metrics
--                                   (renderSalesMetrics in index.html).
--
-- Not for reps or lead buyers. Guardrails are already guardrail_metrics().

create or replace function public.metrics_assert_owner()
returns void language plpgsql stable as $$
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '') in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
end $$;

-- managed: onboarding, active, paused and churned managed clients.
-- ppl: active, paused and churned pay-per-lead clients.
-- Paused is still a client. Someone who joins and leaves in the same month is
-- not in that month's starting count, so not in its rate (joined_and_lost).
create or replace function public.churn_by_month(p_type text default 'managed')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  first_month date;
  stages text[] := case when p_type = 'managed' then array['onboarding', 'active', 'paused', 'churned']
                        else array['active_client', 'paused', 'churned'] end;
  out jsonb := '[]'::jsonb;
  m date;
  r record;
begin
  perform public.metrics_assert_owner();
  if p_type not in ('managed', 'ppl') then raise exception 'type is managed or ppl'; end if;
  select date_trunc('month', min(client_since))::date into first_month from public.clients
   where client_since is not null and type = p_type and stage = any (stages);
  if first_month is null then return out; end if;
  m := first_month;
  while m <= date_trunc('month', today)::date loop
    select
      count(*) filter (where client_since < m and (churned_at is null or churned_at >= m)) as at_start,
      count(*) filter (where client_since < m and churned_at >= m and churned_at < (m + interval '1 month')::date) as lost,
      count(*) filter (where client_since >= m and client_since < (m + interval '1 month')::date) as joined,
      count(*) filter (where client_since >= m and client_since < (m + interval '1 month')::date
                         and churned_at >= m and churned_at < (m + interval '1 month')::date) as joined_lost
      into r from public.clients where client_since is not null and type = p_type and stage = any (stages);
    out := out || jsonb_build_object(
      'month', to_char(m, 'YYYY-MM'), 'label', to_char(m, 'Mon YY'),
      'clients_at_start', r.at_start, 'joined', r.joined, 'lost', r.lost, 'joined_and_lost', r.joined_lost,
      'churn_rate_pct', case when r.at_start > 0 then round(r.lost * 100.0 / r.at_start, 1) end,
      'month_in_progress', today < (m + interval '1 month')::date);
    m := (m + interval '1 month')::date;
  end loop;
  return out;
end $$;

-- The Scoreboard's 15, for a period (Sydney dates, inclusive) and optionally
-- one rep's leads. With a rep, ad spend is their share: spend × their leads ÷
-- all leads. Revenue is the deal value as recorded, incl. GST; gross profit
-- takes the GST off first. LTV is what the business has been billed in total
-- (managed months × fee + logged orders, matched on company name), else the
-- deal value.
create or replace function public.sales_metrics(p_from date default null, p_to date default null, p_owner uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  tz constant text := 'Australia/Sydney';
  f date := coalesce(p_from, date '2000-01-01');
  t date := coalesce(p_to, (now() at time zone tz)::date);
  came int; contactable int; offers int; sales int; revenue numeric; avg_days numeric;
  spend numeric; all_leads int; ltv numeric;
  per_ numeric;
begin
  perform public.metrics_assert_owner();

  select count(*), count(*) filter (where l.contactable is true) into came, contactable
    from public.leads l where (l.created_at at time zone tz)::date between f and t
     and (p_owner is null or l.owner_id = p_owner);
  select count(*) into offers from public.leads l
   where (l.offer_sent_at at time zone tz)::date between f and t and (p_owner is null or l.owner_id = p_owner);
  select count(*), coalesce(sum(value), 0),
         avg(extract(epoch from (won_at - created_at)) / 86400) filter (where won_at is not null)
    into sales, revenue, avg_days
    from public.leads l
   where l.stage = 'closed_won' and (coalesce(l.won_at, l.stage_changed_at) at time zone tz)::date between f and t
     and (p_owner is null or l.owner_id = p_owner);

  spend := (select coalesce(sum(day_spend), 0) from public.ad_spend_daily where account_type = 'agency' and date between f and t);
  if p_owner is not null then
    select count(*) into all_leads from public.leads where created_at::date between f and t;
    spend := case when all_leads > 0 then spend * came / all_leads else 0 end;
  end if;

  with biz as (
    select regexp_replace(lower(coalesce(c.company_name, c.id::text)), '[^a-z0-9]', '', 'g') as b,
           case when c.type = 'managed' then
             coalesce(jsonb_array_length(case when c.active_months ~ '^\s*\[' then c.active_months::jsonb end), 0) * coalesce(c.management_fee, 0)
           else 0 end
           + coalesce((select sum(coalesce(o.leads_qty, 0) * coalesce(o.lead_price, 0)) from public.ppl_order_log o where o.client_id = c.id), 0)
           + coalesce((select sum(coalesce(o.amount, 0)) from public.managed_order_log o where o.client_id = c.id), 0) as billed
      from public.clients c
  ), totals as (select b, sum(billed) total from biz group by b)
  select avg(v) into ltv from (
    select coalesce(nullif(t2.total, 0), l.value) v
      from public.leads l
      left join totals t2 on t2.b = nullif(regexp_replace(lower(coalesce(l.company, '')), '[^a-z0-9]', '', 'g'), '')
     where l.stage = 'closed_won' and (coalesce(l.won_at, l.stage_changed_at) at time zone tz)::date between f and t
       and (p_owner is null or l.owner_id = p_owner)) x
   where v > 0;

  return jsonb_build_object(
    'from', f, 'to', t, 'rep', p_owner,
    'spend_data_to', (select max(date) from public.ad_spend_daily where account_type = 'agency'),
    'lead_volume', came,
    'contactable', contactable,
    'contactable_pct_of_leads', case when came > 0 then round(contactable * 100.0 / came) end,
    'sent_offer', offers,
    'sent_offer_pct_of_contactable', case when contactable > 0 then round(offers * 100.0 / contactable) end,
    'sales', sales,
    'sales_pct_of_offers', case when offers > 0 then round(sales * 100.0 / offers) end,
    'revenue_incl_gst', round(revenue, 2),
    'spent_on_ads', round(spend, 2),
    'return_on_ad_spend', case when spend > 0 then round(revenue / spend, 2) end,
    'cost_per_lead', case when came > 0 then round(spend / came, 2) end,
    'value_per_lead', case when came > 0 then round(revenue / came, 2) end,
    'average_ltv', round(ltv, 2),
    'aov', case when sales > 0 then round(revenue / sales, 2) end,
    'cost_per_offer_sent', case when offers > 0 then round(spend / offers, 2) end,
    'cac', case when sales > 0 then round(spend / sales, 2) end,
    'avg_gross_profit_per_sale', case when sales > 0 then round((revenue / 1.1 - spend) / sales, 2) end,
    'avg_days_to_sale', round(avg_days, 1));
end $$;

grant execute on function public.churn_by_month(text), public.sales_metrics(date, date, uuid) to authenticated, service_role;
grant execute on function public.guardrail_metrics() to service_role;
