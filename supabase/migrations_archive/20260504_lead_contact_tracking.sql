-- Add contact_count to leads table to track how many times each CRM lead
-- has been contacted. Incremented by the UI each time the user logs a new
-- last_contact date against a lead.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS contact_count integer NOT NULL DEFAULT 0;
