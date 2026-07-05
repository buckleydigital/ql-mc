-- Formalise sales_sms_log (Sales Conversations SMS thread store) and lock it
-- down with rep-scoped RLS.
--
-- Context: sales_sms_log already exists in production but was never captured in
-- a migration, and has NO row-level security — meaning every authenticated user
-- (including sales reps) can currently read every sales conversation. This
-- migration recreates it idempotently (a no-op where it already exists) and adds
-- RLS so reps only ever see conversations for leads assigned to them, matching
-- the leads / lead_contact_log scoping already in place.

-- ── Table (no-op if it already exists) ───────────────────────────────────────
create table if not exists public.sales_sms_log (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid references public.leads(id) on delete cascade,
  to_number  text,
  message    text not null,
  sent_by    text,
  twilio_sid text,
  status     text not null default 'pending',
  direction  text not null default 'outbound',
  created_at timestamptz not null default now()
);

alter table public.sales_sms_log
  add column if not exists direction text not null default 'outbound';

create index if not exists idx_sales_sms_log_lead_direction
  on public.sales_sms_log (lead_id, direction, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Full (non-rep) users keep unrestricted access exactly as before RLS existed.
-- Reps get read-only access, scoped to leads they own. Edge functions use the
-- service role and bypass RLS entirely, so mirroring / sending is unaffected.
alter table public.sales_sms_log enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'sales_sms_log' loop
    execute format('drop policy if exists %I on public.sales_sms_log', p.policyname);
  end loop;
end $$;

create policy "ssl_select" on public.sales_sms_log for select to authenticated
  using (
    not public.is_sales_rep()
    or lead_id in (select id from public.leads where owner_id = auth.uid())
  );

create policy "ssl_insert" on public.sales_sms_log for insert to authenticated
  with check (not public.is_sales_rep());

create policy "ssl_update" on public.sales_sms_log for update to authenticated
  using (not public.is_sales_rep())
  with check (not public.is_sales_rep());

create policy "ssl_delete" on public.sales_sms_log for delete to authenticated
  using (not public.is_sales_rep());
