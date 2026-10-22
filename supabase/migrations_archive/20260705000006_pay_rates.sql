-- Pay Rates: role pay definitions (fixed salary or commission %). Internal /
-- owner-only — sales reps must never see this. RLS restricts all access to
-- full (non-rep) users; edge functions use the service role and bypass RLS.

create table if not exists public.pay_rates (
  id         uuid primary key default gen_random_uuid(),
  role_type  text not null,
  rate_type  text not null check (rate_type in ('fixed','commission')),
  amount     numeric not null,
  created_at timestamptz not null default now()
);

alter table public.pay_rates enable row level security;

drop policy if exists "pay_rates_full_users" on public.pay_rates;
create policy "pay_rates_full_users" on public.pay_rates for all to authenticated
  using (not public.is_sales_rep())
  with check (not public.is_sales_rep());
