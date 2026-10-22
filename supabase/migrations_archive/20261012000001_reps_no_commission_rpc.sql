-- Reps no longer see their commission per close: it is worked out from their
-- deal values, so it gives away what each deal is worth. The app has stopped
-- asking for it; this stops a rep calling it from the API with their own
-- token. Full users can still ask about any rep; the service role is
-- unaffected. Otherwise unchanged from 20261007000010.

create or replace function public.rep_commission_summary(p_rep uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  acct text := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  v_rep uuid;
  v_name text;
  r jsonb;
begin
  if auth.uid() is null or acct in ('lead_buyer', 'sales_rep') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  v_rep := coalesce(p_rep, auth.uid());
  select name into v_name from public.sales_reps where user_id = v_rep;
  if v_name is null or btrim(v_name) = '' then
    return jsonb_build_object('rep', false);
  end if;

  with won as (
    select l.value,
           (select pr.amount from public.pay_rates pr
             where pr.rate_type = 'commission'
               and lower(pr.role_type) like lower(btrim(v_name)) || ' -%'
               and case when l.lead_type = 'managed' then pr.role_type ilike '%managed%'
                        else pr.role_type ilike '%ppl%' end
             order by pr.created_at desc limit 1) as pct
      from public.leads l
     where l.owner_id = v_rep and l.stage = 'closed_won'
  ), priced as (
    select value, pct, round(value / 1.1 * pct / 100, 2) as commission
      from won where coalesce(value, 0) > 0 and pct is not null
  )
  select jsonb_build_object(
    'rep', true,
    'name', v_name,
    'closes', (select count(*) from won),
    'priced', (select count(*) from priced),
    'no_value', (select count(*) from won where coalesce(value, 0) <= 0),
    'no_rate', (select count(*) from won where coalesce(value, 0) > 0 and pct is null),
    'total', coalesce((select sum(commission) from priced), 0),
    'average', (select round(avg(commission), 2) from priced))
  into r;
  return r;
end;
$$;

revoke all on function public.rep_commission_summary(uuid) from public, anon;
grant execute on function public.rep_commission_summary(uuid) to authenticated;
