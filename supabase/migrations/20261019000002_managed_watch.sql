-- Phase 5: launching managed campaigns and watching them. Managed only: none
-- of this reads or writes pay-per-lead's tables.
--
-- clients.managed_cpl_target  the most a lead should cost this client; set by
--   the team in Mission Control's Managed Ads section, never by the client
-- managed_campaigns            gains what the watch last saw
-- managed_launch_log           who launched what, when, on what budget
-- managed_alerts               the watch's open alerts. Jarvis's scan reads
--   them alongside its own checks, so they reach the panel, texts and calls
--   the same way, and clear themselves once the watch stops seeing them.

alter table public.clients add column if not exists managed_cpl_target numeric;

alter table public.managed_campaigns
  add column if not exists effective_status text,
  add column if not exists daily_budget numeric,
  add column if not exists spend_today numeric,
  add column if not exists spend_7d numeric,
  add column if not exists leads_7d integer,
  add column if not exists cpl_7d numeric,
  add column if not exists issues jsonb not null default '[]'::jsonb,
  add column if not exists checked_at timestamptz;

create table if not exists public.managed_launch_log (
  id                  uuid primary key default gen_random_uuid(),
  managed_campaign_id uuid references public.managed_campaigns(id) on delete set null,
  client_id           uuid references public.clients(id) on delete set null,
  action              text not null check (action in ('launch', 'pause')),
  by_name             text,
  daily_budget        numeric,
  preflight           jsonb,
  created_at          timestamptz not null default now()
);
alter table public.managed_launch_log enable row level security;
create policy "Authenticated users can read managed_launch_log" on public.managed_launch_log
  for select to authenticated using (true);
create policy "Service role full access to managed_launch_log" on public.managed_launch_log
  for all to service_role using (true) with check (true);

create table if not exists public.managed_alerts (
  dedup_key   text primary key,
  managed_campaign_id uuid references public.managed_campaigns(id) on delete cascade,
  kind        text not null,
  tier        text not null check (tier in ('urgent', 'notable')),
  subject     text,
  payload     jsonb not null default '{}'::jsonb,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);
alter table public.managed_alerts enable row level security;
create policy "Authenticated users can read managed_alerts" on public.managed_alerts
  for select to authenticated using (true);
create policy "Service role full access to managed_alerts" on public.managed_alerts
  for all to service_role using (true) with check (true);

-- Jarvis's scan, plus the managed alerts. The original body lives on as
-- jarvis_scan_base; a later change to Jarvis's own checks goes there, so this
-- wrapper keeps the managed alerts in.
alter function public.jarvis_scan() rename to jarvis_scan_base;
create function public.jarvis_scan()
returns table(kind text, dedup_key text, tier text, subject text, payload jsonb)
language sql stable
set search_path = public
as $$
  select * from public.jarvis_scan_base()
  union all
  select a.kind, a.dedup_key, a.tier, a.subject, a.payload from public.managed_alerts a where a.active
$$;
revoke all on function public.jarvis_scan() from public, anon, authenticated;
grant execute on function public.jarvis_scan() to service_role;

-- The watch, hourly, with the key the scheduled jobs use.
select cron.schedule(
  'managed-campaign-watch',
  '17 * * * *',
  $$ select net.http_post(
       url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/managed-campaigns',
       headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
       body    := '{"action":"watch"}'::jsonb,
       timeout_milliseconds := 120000) $$
);
