-- Add Meta campaign integration fields to clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_campaign_ids text[] DEFAULT NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_cap_paused boolean DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_cap_paused_at timestamptz DEFAULT NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_cap_pause_reason text DEFAULT NULL;

-- Create meta_campaigns table for managing campaigns
CREATE TABLE IF NOT EXISTS meta_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  meta_campaign_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED')),
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE meta_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can manage meta_campaigns" ON meta_campaigns;
CREATE POLICY "Authenticated users can manage meta_campaigns"
  ON meta_campaigns FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access to meta_campaigns" ON meta_campaigns;
CREATE POLICY "Service role full access to meta_campaigns"
  ON meta_campaigns FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Create log table for Meta API actions
CREATE TABLE IF NOT EXISTS meta_api_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  campaign_ids text[] DEFAULT '{}',
  results jsonb DEFAULT '[]',
  triggered_by text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE meta_api_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read meta_api_log" ON meta_api_log;
CREATE POLICY "Authenticated users can read meta_api_log"
  ON meta_api_log FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert meta_api_log" ON meta_api_log;
CREATE POLICY "Authenticated users can insert meta_api_log"
  ON meta_api_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access to meta_api_log" ON meta_api_log;
CREATE POLICY "Service role full access to meta_api_log"
  ON meta_api_log FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
