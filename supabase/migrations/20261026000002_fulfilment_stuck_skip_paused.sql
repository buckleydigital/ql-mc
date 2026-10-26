-- Paused clients are not being fulfilled either, so they leave Fulfilment
-- Watch along with churned ones until they are resumed.
create or replace view public.fulfilment_stuck with (security_invoker=true) as
 SELECT id AS client_id,
    company_name,
    stage,
    onboarding_sub_stage,
    ql_hq_company_id,
    fulfilment_next_step,
    fulfilment_next_due,
    fulfilment_blocked_count,
    fulfilment_steps_settled,
    fulfilment_steps_total,
    fulfilment_stage_at,
    GREATEST(0::numeric, EXTRACT(epoch FROM now() - fulfilment_next_due) / 3600::numeric)::integer AS hours_overdue
   FROM clients c
  WHERE NOT is_sales_rep()
    AND stage IS DISTINCT FROM 'churned'
    AND stage IS DISTINCT FROM 'paused'
    AND fulfilment_next_step IS NOT NULL
    AND (fulfilment_next_due IS NOT NULL AND fulfilment_next_due < now() OR COALESCE(fulfilment_blocked_count, 0) > 0);
