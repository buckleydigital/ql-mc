-- Add Meta campaign integration fields to clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_campaign_ids text[] DEFAULT NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_cap_paused boolean DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_cap_paused_at timestamptz DEFAULT NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_cap_pause_reason text DEFAULT NULL;

-- Create log table for Meta API actions
CREATE TABLE IF NOT EXISTS meta_api_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  campaign_ids text[] DEFAULT '{}',
  results jsonb DEFAULT '[]',
  triggered_by text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS on the log table
ALTER TABLE meta_api_log ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read and insert logs
CREATE POLICY "Authenticated users can read meta_api_log"
  ON meta_api_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert meta_api_log"
  ON meta_api_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Allow service role full access (for cron/edge functions)
CREATE POLICY "Service role full access to meta_api_log"
  ON meta_api_log FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
