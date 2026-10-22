-- Ensure ppl_order_log exists. This table was created in production before
-- the migration trail was formalised; this migration makes it idempotent.
CREATE TABLE IF NOT EXISTS public.ppl_order_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid        REFERENCES public.clients(id) ON DELETE CASCADE,
  leads_qty     integer     NOT NULL DEFAULT 0,
  lead_price    numeric,
  notes         text,
  order_date    date,
  purchase_date date,
  status        text        NOT NULL DEFAULT 'in_progress'
                            CHECK (status IN ('in_progress','completed','cancelled')),
  sla_due_date  date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);

-- RLS: admin access only (service-role bypasses RLS anyway)
ALTER TABLE public.ppl_order_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_all" ON public.ppl_order_log;
CREATE POLICY "admin_all" ON public.ppl_order_log
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS ppl_order_log_client_idx
  ON public.ppl_order_log (client_id);
CREATE INDEX IF NOT EXISTS ppl_order_log_status_idx
  ON public.ppl_order_log (status);
CREATE INDEX IF NOT EXISTS ppl_order_log_order_date_idx
  ON public.ppl_order_log (order_date DESC);
