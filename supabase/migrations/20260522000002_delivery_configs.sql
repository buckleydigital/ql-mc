CREATE TABLE IF NOT EXISTS public.delivery_configs (
  ql_hq_company_id  text        PRIMARY KEY,
  company_name      text        NOT NULL,
  email             text,
  sms_number        text,
  webhook_url       text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.delivery_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_all" ON public.delivery_configs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
