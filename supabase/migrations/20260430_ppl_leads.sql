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
  address             text,
  suburb              text,
  state               text,
  property_type       text,
  roof_type           text,
  monthly_bill        numeric,
  system_size         numeric,
  lead_type           text,
  source              text        NOT NULL DEFAULT 'webhook',
  custom_fields       text,
  is_homeowner        boolean,
  avg_quarterly_bill  numeric,
  interested_in       text,
  purchase_timeline   text,
  phone_verified      boolean,
  email_verified      boolean,
  assigned_client_id  uuid        REFERENCES clients(id) ON DELETE SET NULL,
  assigned_at         timestamptz,
  delivery_method     text,
  delivered_at        timestamptz,
  delivery_error      text,
  delivery_audit_log  jsonb,
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','assigned','delivered','failed','scrubbed')),
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
CREATE INDEX IF NOT EXISTS ppl_leads_lead_type_idx        ON ppl_leads (lead_type);
CREATE INDEX IF NOT EXISTS ppl_leads_created_at_idx       ON ppl_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS ppl_leads_assigned_client_status_idx
  ON ppl_leads (assigned_client_id, status);
