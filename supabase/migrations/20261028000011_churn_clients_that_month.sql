-- Churn is clients lost in a month ÷ every client we had in that month (there
-- at its start or joining during it), not ÷ the clients at its start. A month
-- that began with none still has a rate once clients join.

create or replace function public.churn_by_month(p_type text default 'managed')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  first_month date;
  stages text[] := case when p_type = 'managed' then array['onboarding', 'active', 'paused', 'churned']
                        else array['active_client', 'paused', 'churned'] end;
  out jsonb := '[]'::jsonb;
  m date;
  nxt date;
  r record;
begin
  perform public.metrics_assert_owner();
  if p_type not in ('managed', 'ppl') then raise exception 'type is managed or ppl'; end if;
  select date_trunc('month', min(client_since))::date into first_month from public.clients
   where client_since is not null and type = p_type and stage = any (stages);
  if first_month is null then return out; end if;
  m := first_month;
  while m <= date_trunc('month', today)::date loop
    nxt := (m + interval '1 month')::date;
    select
      count(*) filter (where client_since < nxt and (churned_at is null or churned_at >= m)) as had,
      count(*) filter (where client_since < nxt and churned_at >= m and churned_at < nxt) as lost,
      count(*) filter (where client_since >= m and client_since < nxt) as joined
      into r from public.clients where client_since is not null and type = p_type and stage = any (stages);
    out := out || jsonb_build_object(
      'month', to_char(m, 'YYYY-MM'), 'label', to_char(m, 'Mon YY'),
      'clients_that_month', r.had, 'joined', r.joined, 'lost', r.lost,
      'churn_rate_pct', case when r.had > 0 then round(r.lost * 100.0 / r.had, 1) end,
      'month_in_progress', today < nxt);
    m := nxt;
  end loop;
  return out;
end $$;
