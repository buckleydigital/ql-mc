-- Drop the legacy check constraint inherited when the table was solar_leads.
-- ppl_leads now accepts any lead_type string (solar, aircon, hvac, etc.).
ALTER TABLE ppl_leads DROP CONSTRAINT IF EXISTS solar_leads_lead_type_check;
