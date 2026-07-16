-- sales_sms_log already existed in production before it was captured in
-- migrations, and 20260705000004 used `create table if not exists`, so any
-- columns missing from the pre-existing table were never added. That surfaced
-- as: "Could not find the 'sent_by' column of 'sales_sms_log'" when the agency
-- SMS mirror (sync-sales-conversation) first ran. Add every column the mirror
-- writes, idempotently, to reconcile the live table with the code.
alter table public.sales_sms_log add column if not exists to_number  text;
alter table public.sales_sms_log add column if not exists sent_by    text;
alter table public.sales_sms_log add column if not exists twilio_sid text;
alter table public.sales_sms_log add column if not exists status     text not null default 'pending';
alter table public.sales_sms_log add column if not exists direction  text not null default 'outbound';
alter table public.sales_sms_log add column if not exists created_at timestamptz not null default now();

-- Force PostgREST to refresh its schema cache so the new columns are usable
-- immediately (the original error was a schema-cache miss).
notify pgrst, 'reload schema';
