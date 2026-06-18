-- =============================================================================
-- sales-rep account type
-- =============================================================================
-- Adds a restricted "sales_rep" account type to the ql-mc back-office. A rep
-- can ONLY see the Sales Pipeline and the Invoices that belong to them; the
-- rest of the dashboard (PPL clients, managed ads, finance, lead distribution,
-- etc.) stays invisible. Everyone else (the owner / full internal users) keeps
-- full access exactly as before.
--
-- Identity lives in Supabase auth: app_metadata.account_type = 'sales_rep'.
-- That value rides inside the JWT, so RLS can scope rows without a profiles
-- table (ql-mc has none — full users are simply "not a sales_rep").
--
-- Scoping model:
--   leads             → rep sees only rows where owner_id = their user id
--   lead_contact_log  → rep sees only logs for leads they own (powers stats)
--   invoices          → rep sees only rows where owner_id = their user id
--
-- A BEFORE INSERT trigger auto-assigns new pipeline leads to a rep when the
-- owner is configured to do so (see sales_rep_config).
-- =============================================================================

-- ── Helper: is the current caller a sales rep? ──────────────────────────────
create or replace function public.is_sales_rep()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'account_type') = 'sales_rep',
    false
  );
$$;

-- ── Ownership columns ───────────────────────────────────────────────────────
alter table public.leads    add column if not exists owner_id uuid;
alter table public.invoices add column if not exists owner_id uuid;

create index if not exists leads_owner_id_idx    on public.leads (owner_id);
create index if not exists invoices_owner_id_idx on public.invoices (owner_id);

-- ── Sales-rep roster ────────────────────────────────────────────────────────
-- Mirrors the relevant bits of auth.users so the admin panel and the
-- auto-assign trigger can read reps without touching the auth schema.
create table if not exists public.sales_reps (
  user_id    uuid primary key,
  email      text,
  name       text,
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);
alter table public.sales_reps enable row level security;
-- No permissive policy: only the service-role edge function (and the
-- SECURITY DEFINER trigger below) ever read/write this roster.

-- ── Auto-assignment config (single row) ─────────────────────────────────────
create table if not exists public.sales_rep_config (
  id                  int         primary key default 1,
  auto_assign_enabled boolean     not null default false,
  updated_at          timestamptz not null default now(),
  constraint sales_rep_config_singleton check (id = 1)
);
insert into public.sales_rep_config (id) values (1) on conflict (id) do nothing;
alter table public.sales_rep_config enable row level security;
-- Service-role only, same as sales_reps.

-- ── Auto-assign new pipeline leads ──────────────────────────────────────────
-- • A rep who creates a lead always owns it.
-- • Otherwise, when auto-assign is enabled, the lead goes to the active rep
--   with the fewest open (non-closed) leads — fair, stateless load balancing.
-- • When disabled (or no active reps), the lead stays unassigned until the
--   owner assigns it by hand.
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
begin
  if NEW.owner_id is not null then
    return NEW;
  end if;

  v_type := auth.jwt() -> 'app_metadata' ->> 'account_type';
  if v_type = 'sales_rep' then
    NEW.owner_id := auth.uid();
    return NEW;
  end if;

  select auto_assign_enabled into v_enabled from public.sales_rep_config where id = 1;
  if not coalesce(v_enabled, false) then
    return NEW;
  end if;

  select r.user_id into v_rep
  from public.sales_reps r
  where r.active = true
  order by (
    select count(*) from public.leads l
    where l.owner_id = r.user_id
      and coalesce(l.stage, '') not in ('closed_won', 'closed_lost', 'churned')
  ) asc, random()
  limit 1;

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

-- ── Default invoice owner to its creator ────────────────────────────────────
create or replace function public.set_invoice_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.owner_id is null then
    NEW.owner_id := auth.uid();
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_set_invoice_owner on public.invoices;
create trigger trg_set_invoice_owner
  before insert on public.invoices
  for each row execute function public.set_invoice_owner();

-- ── RLS: leads ──────────────────────────────────────────────────────────────
-- Wipe any pre-existing policies so the scoping is unambiguous, then rebuild.
alter table public.leads enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'leads' loop
    execute format('drop policy if exists %I on public.leads', p.policyname);
  end loop;
end $$;

create policy "leads_select" on public.leads for select to authenticated
  using (not public.is_sales_rep() or owner_id = auth.uid());
create policy "leads_insert" on public.leads for insert to authenticated
  with check (not public.is_sales_rep() or owner_id = auth.uid());
create policy "leads_update" on public.leads for update to authenticated
  using (not public.is_sales_rep() or owner_id = auth.uid())
  with check (not public.is_sales_rep() or owner_id = auth.uid());
-- Only full users can delete pipeline leads.
create policy "leads_delete" on public.leads for delete to authenticated
  using (not public.is_sales_rep());

-- ── RLS: lead_contact_log ───────────────────────────────────────────────────
alter table public.lead_contact_log enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'lead_contact_log' loop
    execute format('drop policy if exists %I on public.lead_contact_log', p.policyname);
  end loop;
end $$;

create policy "lcl_select" on public.lead_contact_log for select to authenticated
  using (
    not public.is_sales_rep()
    or lead_id in (select id from public.leads where owner_id = auth.uid())
  );
create policy "lcl_insert" on public.lead_contact_log for insert to authenticated
  with check (
    not public.is_sales_rep()
    or lead_id in (select id from public.leads where owner_id = auth.uid())
  );
create policy "lcl_update" on public.lead_contact_log for update to authenticated
  using (
    not public.is_sales_rep()
    or lead_id in (select id from public.leads where owner_id = auth.uid())
  );
create policy "lcl_delete" on public.lead_contact_log for delete to authenticated
  using (not public.is_sales_rep());

-- ── RLS: invoices ───────────────────────────────────────────────────────────
alter table public.invoices enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'invoices' loop
    execute format('drop policy if exists %I on public.invoices', p.policyname);
  end loop;
end $$;

create policy "invoices_select" on public.invoices for select to authenticated
  using (not public.is_sales_rep() or owner_id = auth.uid());
create policy "invoices_insert" on public.invoices for insert to authenticated
  with check (not public.is_sales_rep() or owner_id = auth.uid());
create policy "invoices_update" on public.invoices for update to authenticated
  using (not public.is_sales_rep() or owner_id = auth.uid())
  with check (not public.is_sales_rep() or owner_id = auth.uid());
create policy "invoices_delete" on public.invoices for delete to authenticated
  using (not public.is_sales_rep() or owner_id = auth.uid());

-- ── RLS: business_settings (read-only for reps) ─────────────────────────────
-- Reps need to READ this so their invoices render with the logo / defaults,
-- but they must never WRITE the company-wide settings.
alter table public.business_settings enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'business_settings' loop
    execute format('drop policy if exists %I on public.business_settings', p.policyname);
  end loop;
end $$;

create policy "bs_select" on public.business_settings for select to authenticated
  using (true);
create policy "bs_insert" on public.business_settings for insert to authenticated
  with check (not public.is_sales_rep());
create policy "bs_update" on public.business_settings for update to authenticated
  using (not public.is_sales_rep()) with check (not public.is_sales_rep());
create policy "bs_delete" on public.business_settings for delete to authenticated
  using (not public.is_sales_rep());

-- ── Defence in depth: wall reps off from every other table ──────────────────
-- A rep's UI only exposes the pipeline + their invoices, but we also deny them
-- at the data layer so a hand-crafted query can't reach anything else.
-- A RESTRICTIVE policy ANDs with whatever permissive policy already exists, so
-- full users are unaffected. We ONLY touch tables that already have a
-- permissive policy (i.e. RLS already in force) — that guarantees we can never
-- accidentally lock everyone out of a table that was relying on open access.
-- `business_settings` is intentionally excluded: reps need it to render
-- invoices. leads / lead_contact_log / invoices are already scoped above.
do $$
declare t text;
begin
  foreach t in array array[
    'clients','expenses','ad_spend_daily','subscriptions','monthly_goals',
    'campaign_spend_log','ppl_order_log','managed_order_log','meta_campaigns',
    'meta_ad_accounts','meta_api_log','flagged_emails','tasks','agent_files',
    'lead_pricing_areas','ppl_lead_areas','ppl_leads','lead_delivery_log',
    'client_action_log','lead_sms_log','pending_orders','daily_notes'
  ]
  loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = t)
       and exists (
         select 1 from pg_policies
         where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE'
       )
    then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "no_sales_rep" on public.%I', t);
      execute format(
        'create policy "no_sales_rep" on public.%I as restrictive for all to authenticated '
        || 'using (not public.is_sales_rep()) with check (not public.is_sales_rep())', t);
    end if;
  end loop;
end $$;
