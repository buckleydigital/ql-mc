-- The address sales email goes out from, and the one replies come back to.
--
-- These were applied to production first, while working out what the Jarvis
-- bridge needed, and are written down here so a fresh database matches the live
-- one. Both are nullable and both have a fallback in send-sales-email, so an
-- empty column behaves exactly as it did before they existed.
--
-- Why settings and not secrets: which address a business sends from is a
-- business decision, not a deployment one. Putting it in a secret means a
-- redeploy every time someone wants their email to come from a different
-- mailbox, and nobody can see the current value without shell access.
alter table public.business_settings
  add column if not exists sales_from_email text,
  add column if not exists sales_reply_to_email text;

comment on column public.business_settings.sales_from_email is
  'From: address for sales email. Must be on a domain verified with the email provider. Blank falls back to the RESEND_FROM_EMAIL secret.';

comment on column public.business_settings.sales_reply_to_email is
  'Default Reply-To when no rep is behind the send - which is exactly the case for a follow-up Jarvis sends. A rep''s own address always wins over this, so it never routes a rep''s replies away from them.';
