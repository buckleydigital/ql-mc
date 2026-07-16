-- SMS opt-out tracking for sales-pipeline leads. Set true when a lead replies
-- STOP / UNSUBSCRIBE etc. Bulk and manual sends must NEVER message an opted-out
-- lead (legal requirement under the Australian Spam Act). Cleared if they reply
-- START to resubscribe.
alter table public.leads add column if not exists sms_opted_out boolean not null default false;
alter table public.leads add column if not exists sms_opted_out_at timestamptz;

create index if not exists idx_leads_sms_opted_out
  on public.leads (sms_opted_out) where sms_opted_out;
