-- Create ppl_leads table.
-- ppl_leads stores the leads we SELL (pay-per-lead distribution leads), submitted
-- via the submit-lead edge function. This was previously called solar_leads and
-- later merged into the shared `leads` table, but that caused confusion because
-- `leads` also stores our agency's own CRM/sales-pipeline records.
--
-- Separation:
--   leads     = agency CRM pipeline (prospects, clients in stages, internal records)
--   ppl_leads = PPL distribution leads (submitted by external sources, sold to clients)

CREATE TABLE IF NOT EXISTS ppl_leads (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text        NOT NULL,
  email               text,
  phone               text,
  postcode            text,
  suburb              text,
  state               text,
  niche               text        NOT NULL DEFAULT 'solar',
  subtype             text,
  source              text        NOT NULL DEFAULT 'webhook',
  custom_data         jsonb       NOT NULL DEFAULT '{}',
  is_homeowner        boolean,
  avg_quarterly_bill  numeric,
  interested_in       text,
  purchase_timeline   text,
  assigned_client_id  uuid        REFERENCES clients(id) ON DELETE SET NULL,
  assigned_at         timestamptz,
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','assigned','delivered','failed','scrubbed')),
  delivery_attempts   integer     NOT NULL DEFAULT 0,
  last_delivery_at    timestamptz,
  delivery_error      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz
);

-- RLS
ALTER TABLE ppl_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_all" ON ppl_leads;
CREATE POLICY "admin_all" ON ppl_leads FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS ppl_leads_status_idx           ON ppl_leads (status);
CREATE INDEX IF NOT EXISTS ppl_leads_niche_idx            ON ppl_leads (niche);
CREATE INDEX IF NOT EXISTS ppl_leads_created_at_idx       ON ppl_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS ppl_leads_assigned_client_status_idx
  ON ppl_leads (assigned_client_id, status);

-- Migrate existing distribution leads out of the shared `leads` table.
-- Distribution leads are those whose lead_type is NULL or 'solar' (the default
-- that submit-lead never overrode). Agency CRM leads have lead_type = 'ppl' or
-- 'managed', set explicitly by the add_lead RPC.
INSERT INTO ppl_leads (
  id, name, email, phone, postcode, suburb, state,
  niche, subtype, source, custom_data,
  is_homeowner, avg_quarterly_bill, interested_in, purchase_timeline,
  assigned_client_id, assigned_at, status,
  delivery_attempts, last_delivery_at, delivery_error,
  created_at, updated_at
)
SELECT
  id, name, email, phone, postcode, suburb, state,
  COALESCE(niche, 'solar'), subtype, COALESCE(source, 'webhook'), COALESCE(custom_data, '{}'),
  is_homeowner, avg_quarterly_bill, interested_in, purchase_timeline,
  assigned_client_id, assigned_at, COALESCE(status, 'pending'),
  COALESCE(delivery_attempts, 0), last_delivery_at, delivery_error,
  created_at, updated_at
FROM leads
WHERE lead_type IS NULL OR lead_type NOT IN ('ppl', 'managed')
ON CONFLICT (id) DO NOTHING;

-- Re-point lead_delivery_log to ppl_leads.
-- Drop the old FK that references leads(id) and add one for ppl_leads(id).
ALTER TABLE lead_delivery_log
  DROP CONSTRAINT IF EXISTS lead_delivery_log_lead_id_fkey;

ALTER TABLE lead_delivery_log
  ADD CONSTRAINT lead_delivery_log_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES ppl_leads(id) ON DELETE CASCADE;

-- Re-point lead_sms_log to ppl_leads.
ALTER TABLE lead_sms_log
  DROP CONSTRAINT IF EXISTS lead_sms_log_lead_id_fkey;

ALTER TABLE lead_sms_log
  ADD CONSTRAINT lead_sms_log_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES ppl_leads(id) ON DELETE CASCADE;
