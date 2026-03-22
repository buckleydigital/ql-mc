-- Add cached insight stats to meta_campaigns for display in the UI
ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS spend_mtd numeric DEFAULT 0;
ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS impressions_mtd integer DEFAULT 0;
ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS clicks_mtd integer DEFAULT 0;
ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS leads_mtd integer DEFAULT 0;
ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS cpl_mtd numeric DEFAULT 0;
ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS last_synced_at timestamptz DEFAULT NULL;
