-- Automatic email to a pipeline lead left in No Answer for 3 days.
--
-- stage_changed_at records when a lead entered its current stage, so "in No
-- Answer for 3 days" can be measured. It is only set from now on: leads
-- already in No Answer have none and are never emailed automatically, so
-- turning this on does not email old leads out of the blue.
--
-- no_answer_email_sent_at makes it once per lead, kept apart from
-- followup_sent_at so the post-call Follow Up button stays available.
--
-- The email itself is in business_settings, edited in Settings.

alter table public.leads
  add column if not exists stage_changed_at timestamptz,
  add column if not exists no_answer_email_sent_at timestamptz;

create or replace function public.leads_stamp_stage_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  return new;
end $$;

create trigger leads_stamp_stage_change
  before insert or update of stage on public.leads
  for each row execute function public.leads_stamp_stage_change();

alter table public.business_settings
  add column if not exists no_answer_email_enabled boolean not null default true,
  add column if not exists no_answer_email_days integer not null default 3,
  add column if not exists no_answer_email_subject text not null default 'Sorry I missed you, {first_name}',
  add column if not exists no_answer_email_body text not null default E'Hi {first_name},\n\nI tried giving you a call about your enquiry with QuoteLeads but couldn''t catch you.\n\nWhat''s a good time for a quick 10 minute chat? Just reply with a time that suits and I''ll ring you then.\n\n{rep_name}\nQuoteLeads';

alter table public.sales_email_log drop constraint if exists sales_email_log_kind_check;
alter table public.sales_email_log
  add constraint sales_email_log_kind_check check (kind in ('info', 'followup', 'campaign', 'no_answer'));

-- Once a day at 10am Sydney time (00:00 UTC in summer, 23:00 in winter, so
-- it runs both hours and the 3-day check and once-only stamp keep it to one
-- email per lead).
select cron.schedule('no-answer-email', '0 23,0 * * *', $cron$
  select net.http_post(
    url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/pipeline-no-answer-email',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
    body    := '{}'::jsonb)
$cron$);

-- Added and then not used: unassigned leads are signed just "QuoteLeads".
alter table public.business_settings
  add column if not exists no_answer_email_signoff text not null default '';
