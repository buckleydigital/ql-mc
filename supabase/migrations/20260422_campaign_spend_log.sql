-- Campaign Spend Log
-- Stores spend data per campaign per month independently from meta_campaigns.
-- Financials reads from this table, so deleting a campaign does not wipe spend history.
-- source = 'sync'   : written automatically when Sync Stats runs
-- source = 'manual' : written by the user via the Manual Spend Log UI

CREATE TABLE IF NOT EXISTS campaign_spend_log (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid        REFERENCES meta_campaigns(id) ON DELETE SET NULL,
  campaign_name    text        NOT NULL,
  meta_campaign_id text,
  period           text        NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- YYYY-MM
  spend            numeric     DEFAULT 0,
  leads            integer     DEFAULT 0,
  clicks           integer     DEFAULT 0,
  impressions      integer     DEFAULT 0,
  source           text        NOT NULL DEFAULT 'sync',  -- 'sync' | 'manual'
  notes            text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- One sync entry per campaign per period (manual entries can be multiple)
CREATE UNIQUE INDEX IF NOT EXISTS campaign_spend_log_sync_uniq
  ON campaign_spend_log (campaign_id, period)
  WHERE source = 'sync';

-- RLS
ALTER TABLE campaign_spend_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users manage spend log"
  ON campaign_spend_log
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
