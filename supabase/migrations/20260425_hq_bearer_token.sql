-- Replace platform_email and twilio_phone on clients with hq_bearer_token.
-- has_quoteleads_platform_account was added to the live DB manually; ensure
-- it exists here for any fresh environment that runs migrations from scratch.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS has_quoteleads_platform_account boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS hq_bearer_token text;

ALTER TABLE clients
  DROP COLUMN IF EXISTS platform_email,
  DROP COLUMN IF EXISTS twilio_phone;
