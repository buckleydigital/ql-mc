-- What a rep earns per close, shown on their own Sales Pipeline strip.
--
-- Commission is worked out from what the admin has entered:
--   - each closed-won lead's value (leads.value), which includes GST, so GST
--     is taken out first: value / 1.1;
--   - the rep's commission % from Pay Rates. Rates are named per person and
--     per kind of deal - "Will - Managed Advertising Closer", "Will - PPL
--     Closer" - so a close uses the rate whose name starts with the rep's name
--     and matches the lead's type (managed, or PPL for anything else).
--
-- Reps cannot read pay_rates (RLS), so this is SECURITY DEFINER and only ever
-- returns the caller's own figures; an admin may ask about any rep.
-- Closes with no value entered, or no matching rate, are counted separately
-- rather than averaged in as zero.

create or replace function public.rep_commission_summary(p_rep uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  acct text := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  v_rep uuid;
  v_name text;
  r jsonb;
begin
  if auth.uid() is null or acct = 'lead_buyer' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  v_rep := case when acct = 'sales_rep' then auth.uid() else coalesce(p_rep, auth.uid()) end;
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
