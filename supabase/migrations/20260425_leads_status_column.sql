-- Add the lead-distribution `status` column to the leads table.
-- The UI (Lead Distribution panel), `submit-lead`, and `deliver-webhook`
-- all read/write `leads.status`, but a previous extension migration
-- (20260416_lead_pipeline.sql) never created the column, so the panel
-- failed to load with: column leads.status does not exist.
--
-- `status` tracks the delivery lifecycle (separate from the CRM `stage`):
--   pending  -> received but not yet matched to a client
--   assigned -> matched to a client, awaiting delivery
--   delivered-> successfully delivered to the client
--   failed   -> delivery attempt failed
--   scrubbed -> rejected/invalidated and replaced

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'assigned', 'delivered', 'failed', 'scrubbed'));

-- Backfill: all existing leads predate the delivery-tracking pipeline and
-- should be treated as already delivered so they don't show up as pending
-- in the Lead Distribution panel.
UPDATE leads SET status = 'delivered' WHERE status = 'pending';

-- Index to speed up the per-status filter and stats queries used by the
-- Lead Distribution panel and the per-client cap counts in submit-lead.
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);
CREATE INDEX IF NOT EXISTS leads_assigned_client_status_idx
  ON leads (assigned_client_id, status);
