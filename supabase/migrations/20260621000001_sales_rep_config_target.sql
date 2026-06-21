-- Allow auto-assign to target a specific rep instead of always picking the
-- least-busy one. When auto_assign_rep_id is set the trigger assigns every
-- new lead to that rep (if they are active); otherwise it falls back to the
-- original least-loaded round-robin logic.

alter table public.sales_rep_config
  add column if not exists auto_assign_rep_id uuid
    references public.sales_reps(user_id) on delete set null;

-- Re-create the trigger function to honour the fixed rep when configured.
create or replace function public.auto_assign_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rep     uuid;
  v_type    text;
  v_enabled boolean;
  v_fixed   uuid;
begin
  if NEW.owner_id is not null then
    return NEW;
  end if;

  v_type := auth.jwt() -> 'app_metadata' ->> 'account_type';
  if v_type = 'sales_rep' then
    NEW.owner_id := auth.uid();
    return NEW;
  end if;

  select auto_assign_enabled, auto_assign_rep_id
    into v_enabled, v_fixed
    from public.sales_rep_config where id = 1;

  if not coalesce(v_enabled, false) then
    return NEW;
  end if;

  -- Try the fixed rep first (only if they are currently active).
  if v_fixed is not null then
    select user_id into v_rep
      from public.sales_reps
      where user_id = v_fixed and active = true;
  end if;

  -- Fall back to least-loaded active rep.
  if v_rep is null then
    select r.user_id into v_rep
      from public.sales_reps r
      where r.active = true
      order by (
        select count(*) from public.leads l
        where l.owner_id = r.user_id
          and coalesce(l.stage, '') not in ('closed_won', 'closed_lost', 'churned')
      ) asc, random()
      limit 1;
  end if;

  if v_rep is not null then
    NEW.owner_id := v_rep;
  end if;
  return NEW;
end;
$$;
