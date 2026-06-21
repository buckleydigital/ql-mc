-- Add direction column to lead_sms_log to distinguish inbound vs outbound messages
ALTER TABLE lead_sms_log
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound';

-- Add Twilio from number to business_settings so it can be configured via UI
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS twilio_from_number text;

-- Index for quick lookup of inbound messages per lead
CREATE INDEX IF NOT EXISTS idx_lead_sms_log_lead_direction
  ON lead_sms_log (lead_id, direction, created_at DESC);
