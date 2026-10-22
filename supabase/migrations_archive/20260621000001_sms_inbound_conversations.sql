-- Add direction column to lead_sms_log to distinguish inbound vs outbound messages
ALTER TABLE lead_sms_log
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound';

-- Fix: lead_sms_log.lead_id was created with REFERENCES leads(id) (the CRM pipeline
-- table) but send-sms and twilio-inbound-sms both use ppl_leads IDs. Drop the old
-- FK and re-add it pointing to the correct table.
DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT constraint_name INTO v_constraint
  FROM information_schema.table_constraints
  WHERE table_name = 'lead_sms_log'
    AND constraint_type = 'FOREIGN KEY'
    AND constraint_name LIKE '%lead_id%';
  IF v_constraint IS NOT NULL THEN
    EXECUTE 'ALTER TABLE lead_sms_log DROP CONSTRAINT ' || quote_ident(v_constraint);
  END IF;
END $$;

ALTER TABLE lead_sms_log
  ADD CONSTRAINT lead_sms_log_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES ppl_leads(id) ON DELETE CASCADE;

-- Add Twilio from number to business_settings so it can be configured via UI
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS twilio_from_number text;

-- Index for quick lookup of messages per lead ordered by time
CREATE INDEX IF NOT EXISTS idx_lead_sms_log_lead_direction
  ON lead_sms_log (lead_id, direction, created_at DESC);
