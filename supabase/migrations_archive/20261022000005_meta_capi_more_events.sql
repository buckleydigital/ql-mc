-- More of our funnel to Meta, not just the sale: a pipeline lead moving to
-- call_back (Call-Back/Booked) sends Schedule, to proposal sends QuoteSent,
-- to closed_won sends Purchase as before. Each event goes once per lead, so
-- meta_capi_events is keyed by (lead, event). An online checkout still sends
-- nothing: the site pixel reported that Purchase.
alter table public.meta_capi_events drop constraint if exists meta_capi_events_pkey;
alter table public.meta_capi_events add primary key (lead_id, event_name);

create or replace function public.send_meta_conversion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event text := case new.stage
    when 'call_back' then 'Schedule'
    when 'proposal' then 'QuoteSent'
    when 'closed_won' then 'Purchase'
  end;
begin
  if v_event is null or old.stage is not distinct from new.stage then
    return new;
  end if;
  -- Online checkout: already reported by the site pixel.
  if v_event = 'Purchase' and new.hq_company_id is not null and old.hq_company_id is null then
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
    body    := jsonb_build_object('action', 'send', 'lead_id', new.id, 'event', v_event),
    timeout_milliseconds := 30000
  );
  return new;
exception
  when others then
    raise warning 'send_meta_conversion failed: %', sqlerrm;
    return new;
end;
$$;
