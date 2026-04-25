-- Replace platform_email and twilio_phone on clients with hq_bearer_token.
-- has_quoteleads_platform_account (boolean) already exists from earlier migrations.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS hq_bearer_token text;

ALTER TABLE clients
  DROP COLUMN IF EXISTS platform_email,
  DROP COLUMN IF EXISTS twilio_phone;
