-- ============================================================================
-- Scrub sync hardening: make mark_lead_scrubbed idempotent and report whether
-- it acted.
--
-- The scrub in ql-mc is the single source of truth for lead credits. It can be
-- triggered from two directions:
--   1. an admin scrubbing in Mission Control, and
--   2. ql-hq calling sync-from-hq {action:'scrub_lead'} when a client's
--      dispute is approved.
-- Both paths land here. The guard means a lead can only ever be scrubbed ONCE:
-- the second call (whichever direction it comes from) returns false and
-- changes nothing, so counters can never double-decrement and ql-hq is never
-- double-notified.
--
-- Returns true when the lead was scrubbed by this call, false when it was
-- already scrubbed. (Return type changed void -> boolean, hence the DROP.)
-- ============================================================================
DROP FUNCTION IF EXISTS mark_lead_scrubbed(uuid);

CREATE OR REPLACE FUNCTION mark_lead_scrubbed(p_lead_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client_id   uuid;
  v_prev_status text;
BEGIN
  SELECT assigned_client_id, status
    INTO v_client_id, v_prev_status
    FROM ppl_leads
   WHERE id = p_lead_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead not found: %', p_lead_id;
  END IF;

  -- idempotent: already scrubbed means nothing to do, no counter movement
  IF v_prev_status = 'scrubbed' THEN
    RETURN false;
  END IF;

  UPDATE ppl_leads
     SET status = 'scrubbed', updated_at = now()
   WHERE id = p_lead_id;

  IF v_client_id IS NOT NULL THEN
    UPDATE clients
       SET leads_delivered = CASE
             WHEN v_prev_status = 'delivered'
               THEN GREATEST(COALESCE(leads_delivered, 0) - 1, 0)
             ELSE COALESCE(leads_delivered, 0)
           END,
           leads_scrubbed = COALESCE(leads_scrubbed, 0) + 1
     WHERE id = v_client_id;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION mark_lead_scrubbed(uuid) TO authenticated, service_role;
