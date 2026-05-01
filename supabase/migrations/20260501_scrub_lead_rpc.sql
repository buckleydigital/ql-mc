-- mark_lead_scrubbed: atomically set a ppl_lead to 'scrubbed' and update
-- client counters so the delivered count stays accurate.
--
-- When a lead is scrubbed:
--   • If it was previously 'delivered', decrement clients.leads_delivered
--     (the scrubbed lead no longer fulfils the client's order).
--   • Always increment clients.leads_scrubbed so the UI knows a replacement
--     lead is owed.

CREATE OR REPLACE FUNCTION mark_lead_scrubbed(p_lead_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id  uuid;
  v_prev_status text;
BEGIN
  SELECT assigned_client_id, status
    INTO v_client_id, v_prev_status
    FROM ppl_leads
   WHERE id = p_lead_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead not found: %', p_lead_id;
  END IF;

  -- Mark the lead as scrubbed
  UPDATE ppl_leads
     SET status = 'scrubbed', updated_at = now()
   WHERE id = p_lead_id;

  -- Adjust client counters when the lead was assigned to a client
  IF v_client_id IS NOT NULL THEN
    UPDATE clients
       SET
         -- Decrement delivered count only if the lead was already delivered
         leads_delivered = CASE
           WHEN v_prev_status = 'delivered'
             THEN GREATEST(COALESCE(leads_delivered, 0) - 1, 0)
           ELSE COALESCE(leads_delivered, 0)
         END,
         -- Always increment scrubbed count: a replacement lead is owed
         leads_scrubbed = COALESCE(leads_scrubbed, 0) + 1
     WHERE id = v_client_id;
  END IF;
END;
$$;

-- mark_lead_delivered: atomically set a ppl_lead to 'delivered' and
-- increment clients.leads_delivered (idempotent — only increments if the
-- lead was not already in 'delivered' status).

CREATE OR REPLACE FUNCTION mark_lead_delivered(p_lead_id uuid, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id  uuid;
  v_prev_status text;
BEGIN
  SELECT assigned_client_id, status
    INTO v_client_id, v_prev_status
    FROM ppl_leads
   WHERE id = p_lead_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead not found: %', p_lead_id;
  END IF;

  -- Mark the lead as delivered
  UPDATE ppl_leads
     SET status = 'delivered', updated_at = now()
   WHERE id = p_lead_id;

  -- Increment delivered count only if it wasn't already counted
  IF v_client_id IS NOT NULL AND v_prev_status <> 'delivered' THEN
    UPDATE clients
       SET leads_delivered = COALESCE(leads_delivered, 0) + 1
     WHERE id = v_client_id;
  END IF;
END;
$$;
