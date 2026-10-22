-- Our own closed sales back to Meta (Conversions API), the same as ql-hq does
-- for clients. When a pipeline lead moves to closed_won, meta-capi sends a
-- Purchase to the dataset in business_settings.meta_dataset_id (the pixel on
-- ql-site), so Meta learns which of our ads bring businesses that sign.
-- No dataset ID saved, no event.
--
-- An online checkout is skipped: sync-from-hq's upsert_managed_purchase marks
-- the lead closed_won in the same write that links its HQ account, and the
-- site's payment-success page already sent that Purchase from the browser.
alter table public.business_settings add column if not exists meta_dataset_id text;
alter table public.business_settings add constraint business_settings_meta_dataset_id_digits
  check (meta_dataset_id is null or meta_dataset_id ~ '^[0-9]{6,20}$');

-- One row per sale sent (or trying to be): once per lead, retried by
-- meta-capi until it has been tried five times.
create table if not exists public.meta_capi_events (
  lead_id     uuid primary key references public.leads(id) on delete cascade,
  dataset_id  text not null,
  event_name  text not null default 'Purchase',
  value       numeric,
  matched_by  text[] not null default '{}',
  sent_at     timestamptz,
  error       text,
  attempts    int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists meta_capi_events_unsent on public.meta_capi_events (created_at) where sent_at is null;
alter table public.meta_capi_events enable row level security;
create policy "Team can read meta_capi_events" on public.meta_capi_events
  for select to authenticated using (not public.is_sales_rep());
create policy "Service role full access to meta_capi_events" on public.meta_capi_events
  for all to service_role using (true) with check (true);

create or replace function public.send_meta_conversion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage is distinct from 'closed_won' or old.stage is not distinct from 'closed_won' then
    return new;
  end if;
  -- Online checkout: already reported by the site pixel.
  if new.hq_company_id is not null and old.hq_company_id is null then
    return new;
  end if;
  if not exists (select 1 from public.business_settings where meta_dataset_id is not null) then
    return new;
  end if;

  perform net.http_post(
    url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/meta-capi',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
    body    := jsonb_build_object('action', 'send', 'lead_id', new.id),
    timeout_milliseconds := 30000
  );
  return new;
exception
  when others then
    raise warning 'send_meta_conversion failed: %', sqlerrm;
    return new;
end;
$$;

create trigger trg_send_meta_conversion
  after update of stage on public.leads
  for each row execute function public.send_meta_conversion();

-- Every 30 minutes: send again any sale Meta didn't take.
select cron.schedule(
  'meta-capi-retry',
  '*/30 * * * *',
  $$ select net.http_post(
       url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/meta-capi',
       headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
       body    := '{"action":"retry"}'::jsonb,
       timeout_milliseconds := 120000) $$
);
