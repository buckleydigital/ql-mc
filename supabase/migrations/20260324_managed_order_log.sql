-- Create managed_order_log table for custom orders / one-off charges on managed clients
CREATE TABLE IF NOT EXISTS managed_order_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  description text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  order_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE managed_order_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage managed_order_log" ON managed_order_log';
  EXECUTE 'DROP POLICY IF EXISTS "Service role full access to managed_order_log" ON managed_order_log';
END $$;

CREATE POLICY "Authenticated users can manage managed_order_log" ON managed_order_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to managed_order_log" ON managed_order_log FOR ALL TO service_role USING (true) WITH CHECK (true);
