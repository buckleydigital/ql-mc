-- Store the Twilio inbound webhook URL in business_settings so it is fetched
-- via authenticated DB query rather than exposed in the page HTML/source.
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS twilio_webhook_url text;
