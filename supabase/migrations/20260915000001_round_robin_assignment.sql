-- =============================================================================
-- Round-robin lead assignment
-- =============================================================================
-- Auto-assign grows from "one fixed rep or the least-busy rep" into three
-- explicit modes:
--
--   least_busy   → active rep with the fewest open leads (the original default)
--   fixed        → always the rep named by auto_assign_rep_id
--   round_robin  → cycle through a hand-picked pool, one lead each, in turn
--
-- The round-robin pool is an ordered text[] whose entries are either a sales
-- rep's user_id, or the literal 'house'. A 'house' turn deliberately leaves the
-- lead UNASSIGNED (owner_id stays null) so it belongs to the main QuoteLeads
-- account (contact@quoteleads.com.au) — reps can't see unassigned leads under
-- RLS, so those leads are admin-only. That is what makes the main account sit
-- in the rotation alongside the reps without needing a rep login of its own.
--
-- Fairness is kept by a monotonic cursor on the config row: each insert bumps
-- it once inside the same transaction, so concurrent inserts can't hand the
-- same slot to two leads.
-- =============================================================================

alter table public.sales_rep_config
  add column if not exists auto_assign_mode    text   not null default 'least_busy',
  add column if not exists round_robin_pool    text[] not null default '{}',
  add column if not exists round_robin_cursor  bigint not null default 0,
  add column if not exists house_email         text   not null default 'contact@quoteleads.com.au';

do $$
begin
  alter table public.sales_rep_config
    add constraint sales_rep_config_mode_chk
    check (auto_assign_mode in ('least_busy', 'fixed', 'round_robin'));
exception when duplicate_object then null;
end $$;

-- Existing installs: a configured fixed rep means they were in "fixed" mode.
update public.sales_rep_config
   set auto_assign_mode = case when auto_assign_rep_id is not null then 'fixed' else 'least_busy' end
 where id = 1 and auto_assign_mode = 'least_busy';

-- ── Pool helper: the configured order, minus reps who are gone or inactive ──
create or replace function public.round_robin_pool()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(e order by ord), '{}'::text[])
  from (select cfg.round_robin_pool from public.sales_rep_config cfg where cfg.id = 1) c,
       unnest(c.round_robin_pool) with ordinality as t(e, ord)
  where e = 'house'
     or exists (select 1 from public.sales_reps r where r.active and r.user_id::text = e);
$$;

-- ── Auto-assign new pipeline leads ──────────────────────────────────────────
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
  v_mode    text;
  v_pool    text[];
  v_pick    text;
  v_n       bigint;
begin
  if NEW.owner_id is not null then
    return NEW;
  end if;

  v_type := auth.jwt() -> 'app_metadata' ->> 'account_type';
  if v_type = 'sales_rep' then
    NEW.owner_id := auth.uid();
    return NEW;
  end if;

  select auto_assign_enabled, auto_assign_rep_id, auto_assign_mode
    into v_enabled, v_fixed, v_mode
    from public.sales_rep_config where id = 1;

  if not coalesce(v_enabled, false) then
    return NEW;
  end if;

  v_mode := coalesce(v_mode, 'least_busy');

  -- ── Round robin: take the next slot in the configured pool ────────────────
  if v_mode = 'round_robin' then
    v_pool := public.round_robin_pool();
    if array_length(v_pool, 1) is null then
      return NEW;  -- nobody in the pool → leave it unassigned
    end if;

    -- Bump the cursor atomically; the row lock serialises concurrent inserts.
    update public.sales_rep_config
       set round_robin_cursor = round_robin_cursor + 1
     where id = 1
    returning round_robin_cursor into v_n;

    v_pick := v_pool[(v_n % array_length(v_pool, 1)) + 1];
    if v_pick is null or v_pick = 'house' then
      return NEW;  -- the main account's turn → stays unassigned, admin-only
    end if;
    NEW.owner_id := v_pick::uuid;
    return NEW;
  end if;

  -- ── Fixed rep (only while they are active) ────────────────────────────────
  if v_mode = 'fixed' and v_fixed is not null then
    select user_id into v_rep
      from public.sales_reps
      where user_id = v_fixed and active = true;
  end if;

  -- ── Least-loaded active rep (default, and the fallback for a dead fixed rep)
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

drop trigger if exists trg_auto_assign_lead on public.leads;
create trigger trg_auto_assign_lead
  before insert on public.leads
  for each row execute function public.auto_assign_lead();
