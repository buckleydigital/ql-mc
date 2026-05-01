-- Fix lead_delivery_log: the lead_id FK was pointing to leads(id) but PPL
-- delivery logs reference ppl_leads(id). Re-point the constraint and add the
-- message_preview column that deliver-webhook already writes to.

-- 1. Drop the old FK (was pointing at the agency CRM leads table)
ALTER TABLE lead_delivery_log
  DROP CONSTRAINT IF EXISTS lead_delivery_log_lead_id_fkey;

-- 2. Re-add FK pointing at ppl_leads
ALTER TABLE lead_delivery_log
  ADD CONSTRAINT lead_delivery_log_ppl_lead_id_fkey
    FOREIGN KEY (lead_id) REFERENCES ppl_leads(id) ON DELETE CASCADE;

-- 3. Add message_preview column (stores email subject or SMS body snippet)
ALTER TABLE lead_delivery_log
  ADD COLUMN IF NOT EXISTS message_preview text;

-- 4. Atomic increment helper used by deliver-webhook
CREATE OR REPLACE FUNCTION increment_leads_delivered(p_client_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE clients
     SET leads_delivered = COALESCE(leads_delivered, 0) + 1
   WHERE id = p_client_id;
$$;
