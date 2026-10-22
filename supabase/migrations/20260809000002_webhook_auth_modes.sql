-- The first pass only supported us signing the request so the client could
-- verify it came from QuoteLeads. In practice most CRMs need the opposite:
-- they issue a credential and expect it back on every request, and the header
-- name varies per CRM (Authorization: Bearer …, X-API-Key: …, or bespoke).
--
-- webhook_auth_mode:
--   'none'      - no auth headers
--   'header'    - send the client's own credential, verbatim, under the
--                 header name they specify
--   'signature' - our HMAC-SHA256 signature plus shared secret (the original
--                 behaviour, kept for clients who want to verify us)

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS webhook_auth_mode   text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS webhook_auth_header text;

ALTER TABLE delivery_configs
  ADD COLUMN IF NOT EXISTS webhook_auth_mode   text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS webhook_auth_header text;

-- Anything already switched on was, by definition, using the signing mode.
UPDATE clients
   SET webhook_auth_mode = 'signature'
 WHERE webhook_auth_enabled IS TRUE AND webhook_auth_mode = 'none';

UPDATE delivery_configs
   SET webhook_auth_mode = 'signature'
 WHERE webhook_auth_enabled IS TRUE AND webhook_auth_mode = 'none';

ALTER TABLE clients
  ADD CONSTRAINT clients_webhook_auth_mode_chk
  CHECK (webhook_auth_mode IN ('none', 'header', 'signature')) NOT VALID;

ALTER TABLE delivery_configs
  ADD CONSTRAINT delivery_configs_webhook_auth_mode_chk
  CHECK (webhook_auth_mode IN ('none', 'header', 'signature')) NOT VALID;

COMMENT ON COLUMN clients.webhook_auth_mode IS
  'none | header (send the client''s credential) | signature (sign with our secret)';
COMMENT ON COLUMN clients.webhook_auth_header IS
  'Header name for mode=header, e.g. Authorization or X-API-Key. Value is stored in webhook_secret.';
