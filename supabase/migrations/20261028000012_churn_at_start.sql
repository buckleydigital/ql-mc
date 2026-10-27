-- Back to the standard churn rate: clients lost in a month ÷ the clients at its
-- start. A client who joins mid-month counts from the next month; one who joins
-- and leaves in the same month is shown (joined_and_lost) but not in the rate.

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
