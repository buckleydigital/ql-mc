-- Daily notes for full daily snapshot logs
CREATE TABLE IF NOT EXISTS daily_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL DEFAULT CURRENT_DATE,
  category text NOT NULL DEFAULT 'general',
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE daily_notes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage daily_notes" ON daily_notes';
  EXECUTE 'DROP POLICY IF EXISTS "Service role full access to daily_notes" ON daily_notes';
END $$;

CREATE POLICY "Authenticated users can manage daily_notes" ON daily_notes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to daily_notes" ON daily_notes FOR ALL TO service_role USING (true) WITH CHECK (true);
