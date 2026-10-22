-- ════════════════════════════════════════════════════════════════════════════
-- Won lead → QuoteLeadsHQ client
--
-- A Closed Won lead gets a ql-hq account created from what is on the lead, and
-- optionally a VA assigned, without leaving this dashboard. The ids come back
-- onto the lead so the button knows it has already run - the guard against a
-- second account is this column, not a disabled button in one browser tab.
--
-- Also retires lead_type from the sales pipeline. Everything sold now is
-- managed; the column stays (PPL clients and the convert-to-client path still
-- read it) but the pipeline no longer asks, and existing rows are untouched.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS hq_company_id         uuid,
  ADD COLUMN IF NOT EXISTS hq_account_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS hq_va_user_id         uuid,
  ADD COLUMN IF NOT EXISTS hq_va_assigned_at     timestamptz;

COMMENT ON COLUMN public.leads.hq_company_id IS
  'companies.id in ql-hq once this won lead has been converted to a client.';

CREATE INDEX IF NOT EXISTS leads_hq_company_idx
  ON public.leads (hq_company_id) WHERE hq_company_id IS NOT NULL;
