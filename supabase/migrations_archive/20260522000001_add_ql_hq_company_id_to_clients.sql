ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS ql_hq_company_id text;

CREATE INDEX IF NOT EXISTS clients_ql_hq_company_id_idx
  ON public.clients (ql_hq_company_id)
  WHERE ql_hq_company_id IS NOT NULL;
