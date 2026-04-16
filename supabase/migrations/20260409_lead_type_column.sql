-- Add lead_type column to leads to support solar and custom lead types
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_type text NOT NULL DEFAULT 'solar' CHECK (lead_type IN ('solar', 'custom'));
