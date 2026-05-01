-- preview_postcode_match
-- Returns the best-matched active PPL client for a given postcode, using the
-- same eligibility rules as the live lead-assignment logic:
--   1. type = 'ppl', stage = 'active_client'
--   2. Remaining capacity: leads_delivered < total_leads_purchased + leads_scrubbed
--   3. Postcode matches (empty/null postcodes array = covers everywhere)
--   4. Weekly cap not exceeded (counted against ppl_leads delivered this ISO week)
--   5. Monthly cap not exceeded (counted against ppl_leads delivered this calendar month)
--   6. Tie-break: least-recently-served first (last delivered_at ASC NULLS FIRST)

CREATE OR REPLACE FUNCTION preview_postcode_match(p_postcode text)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT json_build_object(
    'buyer_name', c.company_name,
    'buyer_id',   c.id
  )
  FROM clients c
  WHERE c.type = 'ppl'
    AND c.stage = 'active_client'
    -- Has remaining capacity
    AND c.leads_delivered < c.total_leads_purchased + COALESCE(c.leads_scrubbed, 0)
    -- Postcode match: null/empty means the client covers all postcodes
    AND (
      c.postcodes IS NULL
      OR array_length(c.postcodes, 1) IS NULL
      OR p_postcode = ANY(c.postcodes)
    )
    -- Weekly cap not exceeded
    AND (
      c.weekly_cap IS NULL
      OR (
        SELECT COUNT(*)
        FROM ppl_leads pl
        WHERE pl.assigned_client_id = c.id
          AND pl.status = 'delivered'
          AND pl.delivered_at >= date_trunc('week', now())
      ) < c.weekly_cap
    )
    -- Monthly cap not exceeded
    AND (
      c.monthly_cap IS NULL
      OR (
        SELECT COUNT(*)
        FROM ppl_leads pl
        WHERE pl.assigned_client_id = c.id
          AND pl.status = 'delivered'
          AND pl.delivered_at >= date_trunc('month', now())
      ) < c.monthly_cap
    )
  ORDER BY
    -- Least-recently-served first
    (
      SELECT MAX(pl.delivered_at)
      FROM ppl_leads pl
      WHERE pl.assigned_client_id = c.id
        AND pl.status = 'delivered'
    ) ASC NULLS FIRST
  LIMIT 1;
$$;
