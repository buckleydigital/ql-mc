-- No Answer follow-ups: day 1, 3, 7 and 10 after a lead is moved to No Answer,
-- each a text and an email (where we have a mobile or an address), in place of
-- the single no-answer email. The four messages live in business_settings,
-- editable under Settings; no_answer_email_enabled stays the on/off for all of
-- it. A step only goes on its day (or the day after, if a morning was missed),
-- so switching on, or a lead sitting there for weeks, never sends a backlog.
-- Moving the lead out of No Answer stops it; moving it back starts again.

alter table public.business_settings
  add column if not exists no_answer_followups jsonb;

-- The existing no-answer email becomes day 1's; the rest are drafts to edit.
update public.business_settings set no_answer_followups = jsonb_build_array(
  jsonb_build_object('day', 1,
    'sms', 'Hi {first_name}, QuoteLeads here. We tried calling about your enquiry for more jobs for {company_name}. When''s a good time for a quick 10 min chat?',
    'subject', coalesce(no_answer_email_subject, 'Sorry I missed you, {first_name}'),
    'email', coalesce(no_answer_email_body, E'Hi {first_name},\n\nI tried giving you a call about your enquiry with QuoteLeads but couldn''t catch you.\n\nWhat''s a good time for a quick 10 minute chat? Just reply with a time that suits and I''ll ring you then.\n\n{rep_name}\nQuoteLeads')),
  jsonb_build_object('day', 3,
    'sms', 'Hi {first_name}, just following up on your QuoteLeads enquiry. Reply with a time that suits and we''ll give you a ring.',
    'subject', 'Following up, {first_name}',
    'email', E'Hi {first_name},\n\nJust following up on your enquiry about getting more jobs for {company_name}. I''ve tried calling but haven''t been able to catch you.\n\nIf you reply with a day and time that suits, I''ll call you then. It only takes 10 minutes.\n\n{rep_name}\nQuoteLeads'),
  jsonb_build_object('day', 7,
    'sms', 'Hi {first_name}, still keen to get more jobs coming in for {company_name}? Reply YES and we''ll give you a call.',
    'subject', 'Still after more jobs, {first_name}?',
    'email', E'Hi {first_name},\n\nI didn''t want your enquiry to slip through the cracks. Are you still looking to get more jobs coming in for {company_name}?\n\nIf so, just reply YES and I''ll give you a quick call to show you how it works.\n\n{rep_name}\nQuoteLeads'),
  jsonb_build_object('day', 10,
    'sms', 'Hi {first_name}, last message from us. If you''d still like more jobs for {company_name}, just reply and we''ll be in touch. All the best!',
    'subject', 'Should I close off your enquiry?',
    'email', E'Hi {first_name},\n\nI''ve tried reaching you a few times about your enquiry with QuoteLeads, so this will be my last email.\n\nIf you''d still like to talk about getting more jobs for {company_name}, just reply and I''ll call you whenever suits. Otherwise, all the best with the business.\n\n{rep_name}\nQuoteLeads')
) where no_answer_followups is null;

-- What has gone, per lead, per time in No Answer, per step and channel: so
-- each goes once, and a failure (opted out, no number) isn't retried daily.
create table if not exists public.no_answer_followup_log (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  entered_at timestamptz not null,          -- when the lead was moved to No Answer
  step_day int not null,
  channel text not null check (channel in ('sms', 'email')),
  ok boolean not null,
  detail text,
  sent_at timestamptz not null default now(),
  unique (lead_id, entered_at, step_day, channel)
);
alter table public.no_answer_followup_log enable row level security;
create policy no_answer_followup_log_read on public.no_answer_followup_log for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));
