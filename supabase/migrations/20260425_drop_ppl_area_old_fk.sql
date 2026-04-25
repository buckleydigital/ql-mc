-- ════════════════════════════════════════════════════════════════════════════
-- Drop the legacy `client_id` column from ppl_lead_areas.
--
-- Multi-client support was added in 20260322_multi_client_areas.sql which
-- introduced `client_ids uuid[]` and migrated the data.  The old scalar
-- `client_id` column is no longer used by any code path.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE ppl_lead_areas
  DROP COLUMN IF EXISTS client_id;
