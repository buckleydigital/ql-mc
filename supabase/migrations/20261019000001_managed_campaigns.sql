-- Managed advertising's own list of Meta campaigns, kept apart from pay-per-lead.
--
-- meta_campaigns and clients.meta_campaign_ids are pay-per-lead's: shared
-- campaigns in QuoteLeads' own ad accounts, synced, capped and cost-checked
-- across PPL buyers. A managed client's campaign runs in their own ad account
-- for them alone, so it lives here instead. ql-hq's campaign builder records
-- each one it makes (register-campaign), and Mission Control's managed section
-- (launch and the watch) works from this table only.
create table if not exists public.managed_campaigns (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid references public.clients(id) on delete set null,
  hq_company_id     text not null,
  meta_campaign_id  text not null unique,
  ad_account_id     text not null,
  name              text not null,
  status            text not null default 'PAUSED' check (status in ('ACTIVE', 'PAUSED')),
  notes             text,
  built_at          timestamptz not null default now(),
  launched_at       timestamptz,
  launched_by       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists managed_campaigns_client on public.managed_campaigns (client_id);
alter table public.managed_campaigns enable row level security;

create policy "Authenticated users can read managed_campaigns" on public.managed_campaigns
  for select to authenticated using (true);
create policy "Service role full access to managed_campaigns" on public.managed_campaigns
  for all to service_role using (true) with check (true);
