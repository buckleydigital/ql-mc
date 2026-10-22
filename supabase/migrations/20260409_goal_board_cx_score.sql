-- Goal Board: monthly goals for revenue, margin, and other targets
CREATE TABLE IF NOT EXISTS monthly_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month text NOT NULL UNIQUE,
  revenue_goal numeric DEFAULT 0,
  margin_goal numeric DEFAULT 0,
  notes text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE monthly_goals ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage monthly_goals" ON monthly_goals';
  EXECUTE 'DROP POLICY IF EXISTS "Service role full access to monthly_goals" ON monthly_goals';
END $$;

CREATE POLICY "Authenticated users can manage monthly_goals" ON monthly_goals FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to monthly_goals" ON monthly_goals FOR ALL TO service_role USING (true) WITH CHECK (true);

-- CX Score on clients (applies to both PPL and Managed)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS cx_score integer DEFAULT NULL;
