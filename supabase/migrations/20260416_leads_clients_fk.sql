-- Ensure the assigned_client_id column exists before adding the FK.
-- The column is created in 20260416_lead_pipeline.sql for fresh setups,
-- but this handles environments where that migration already ran without it.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS assigned_client_id uuid;

-- Add foreign key from leads.assigned_client_id to clients so PostgREST
-- can resolve the relationship for nested selects like clients(company_name).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'leads_assigned_client_id_fkey'
      AND table_name = 'leads'
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_assigned_client_id_fkey
      FOREIGN KEY (assigned_client_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END $$;
