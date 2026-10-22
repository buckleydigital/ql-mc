-- Add columns to clients that are used by submit-lead / postcode-lookup
-- but were never tracked in migrations (existed only in production DB).
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS postcodes             text[]   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS total_leads_purchased integer  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS leads_delivered       integer  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS leads_scrubbed        integer  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_cap            integer,
  ADD COLUMN IF NOT EXISTS monthly_cap           integer,
  ADD COLUMN IF NOT EXISTS delivery_method       text,
  ADD COLUMN IF NOT EXISTS delivery_email        text,
  ADD COLUMN IF NOT EXISTS delivery_phone        text,
  ADD COLUMN IF NOT EXISTS client_webhook        text,
  ADD COLUMN IF NOT EXISTS contact_name          text,
  ADD COLUMN IF NOT EXISTS lead_price            numeric,
  ADD COLUMN IF NOT EXISTS active_status         text;

CREATE INDEX IF NOT EXISTS clients_postcodes_idx
  ON public.clients USING gin (postcodes);
