-- Per-invoice freeform payment details (e.g. "PayID: contact@quoteleads.com.au").
-- Shown in the invoice modal and rendered in the PDF payment section.
-- When blank the PDF falls back to the global business_settings values.
alter table public.invoices
  add column if not exists payment_details text;
