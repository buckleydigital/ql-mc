-- Add CRM follow-up tracking columns to the leads table.
-- The sales pipeline UI in index.html reads/writes these fields when saving
-- a lead (see saveLead and toggleContactable in index.html), but they were
-- never added in an earlier migration. Without them, Supabase returns
-- "Could not find the 'next_followup' column of 'leads' in the schema cache"
-- when the UI tries to update a lead.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS next_followup date,
  ADD COLUMN IF NOT EXISTS last_contact  date,
  ADD COLUMN IF NOT EXISTS contactable   boolean;

-- Useful for the Command Center / alerts query that filters by next_followup.
CREATE INDEX IF NOT EXISTS leads_next_followup_idx ON leads (next_followup);
