-- Outbound lead webhooks had no authentication: the receiving endpoint could
-- not verify a POST came from us, and we could not prove a delivery was
-- genuine. These columns hold an optional per-client secret.
--
-- When auth is enabled the delivery sends both an HMAC-SHA256 signature over
-- the request body and the raw secret in a header, so a client whose CRM
-- cannot compute a hash (Zapier, Make, most no-code tools) can still verify.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS webhook_auth_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS webhook_secret       text;

ALTER TABLE delivery_configs
  ADD COLUMN IF NOT EXISTS webhook_auth_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS webhook_secret       text;

COMMENT ON COLUMN clients.webhook_auth_enabled IS
  'When true, lead webhooks to this client carry X-QuoteLeads-Signature and X-QuoteLeads-Secret headers.';
COMMENT ON COLUMN clients.webhook_secret IS
  'Shared secret for outbound lead webhooks. Readable by admins in Mission Control, matching the existing hq_bearer_token field. Never written to lead_delivery_log.';
