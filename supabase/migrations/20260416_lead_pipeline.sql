-- 1a. Rename table
ALTER TABLE IF EXISTS solar_leads RENAME TO leads;

-- 1b. Extend leads
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS niche             text NOT NULL DEFAULT 'solar',
  ADD COLUMN IF NOT EXISTS subtype           text,
  ADD COLUMN IF NOT EXISTS suburb            text,
  ADD COLUMN IF NOT EXISTS state             text,
  ADD COLUMN IF NOT EXISTS custom_data       jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_delivery_at  timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_error    text;

-- 1c. Extend clients
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS niche             text DEFAULT 'solar',
  ADD COLUMN IF NOT EXISTS active_niches     text[] DEFAULT ARRAY['solar'],
  ADD COLUMN IF NOT EXISTS postcodes_radius  integer DEFAULT 50,
  ADD COLUMN IF NOT EXISTS delivery_email_cc text,
  ADD COLUMN IF NOT EXISTS from_name         text DEFAULT 'QuoteLeads';

-- 1d. Lead delivery audit log
CREATE TABLE IF NOT EXISTS lead_delivery_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid REFERENCES leads(id) ON DELETE CASCADE,
  client_id     uuid REFERENCES clients(id) ON DELETE SET NULL,
  method        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  destination   text,
  response_code integer,
  response_body text,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);

-- 1e. Pending orders bridge table
CREATE TABLE IF NOT EXISTS pending_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_session_id text UNIQUE NOT NULL,
  order_data        jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 1f. Admin SMS log
CREATE TABLE IF NOT EXISTS lead_sms_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    uuid REFERENCES leads(id) ON DELETE CASCADE,
  to_number  text NOT NULL,
  message    text NOT NULL,
  sent_by    text NOT NULL,
  twilio_sid text,
  status     text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 1g. RLS policies
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE 'DROP POLICY IF EXISTS "admin_all" ON leads'; EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE POLICY "admin_all" ON leads FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE lead_delivery_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE 'DROP POLICY IF EXISTS "admin_all" ON lead_delivery_log'; EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE POLICY "admin_all" ON lead_delivery_log FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE pending_orders ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE 'DROP POLICY IF EXISTS "admin_all" ON pending_orders'; EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE POLICY "admin_all" ON pending_orders FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE lead_sms_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN EXECUTE 'DROP POLICY IF EXISTS "admin_all" ON lead_sms_log'; EXCEPTION WHEN undefined_table THEN NULL; END $$;
CREATE POLICY "admin_all" ON lead_sms_log FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
