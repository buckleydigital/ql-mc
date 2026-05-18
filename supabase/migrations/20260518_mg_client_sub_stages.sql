-- Add onboarding sub-stage and active status tracking columns to managed clients.
-- These support the new Onboarding stage (before Active) in the managed advertising
-- kanban, where onboarding clients show a sub-stage dropdown (Paid & Signed, Form
-- Filled, etc.) and active clients show an operational status dropdown (Ads Live,
-- Ads Paused, etc.).
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS onboarding_sub_stage text,
  ADD COLUMN IF NOT EXISTS active_status        text;
