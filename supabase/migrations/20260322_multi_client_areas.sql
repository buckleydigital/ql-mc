-- Add client_ids array to ppl_lead_areas for multi-client support
ALTER TABLE ppl_lead_areas ADD COLUMN IF NOT EXISTS client_ids uuid[] DEFAULT '{}';

-- Migrate existing single client_id data into client_ids array
UPDATE ppl_lead_areas SET client_ids = ARRAY[client_id] WHERE client_id IS NOT NULL AND (client_ids IS NULL OR client_ids = '{}');
