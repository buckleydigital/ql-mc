-- ════════════════════════════════════════════════════════════════════════════
-- Sales info / follow-up emails
--
-- A rep opens a lead, hits Send Info, checks the merged draft and sends. The
-- send itself happens in the send-sales-email edge function under the service
-- role, because reps are view-only on `leads` (20260705000002) and the send
-- has to stamp the lead. That also means the buttons grey out on what actually
-- left the building, not on what the browser believes happened.
--
-- Three pieces here:
--   1. reply_to_email on sales_reps  - replies go to the rep who sent it
--   2. sales_email_templates          - the two shared templates, admin-edited
--   3. send tracking on leads + a log - what was sent, to whom, by whom
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Per-rep reply-to ─────────────────────────────────────────────────────
ALTER TABLE public.sales_reps
  ADD COLUMN IF NOT EXISTS reply_to_email text;

COMMENT ON COLUMN public.sales_reps.reply_to_email IS
  'Reply-To on sales emails this rep sends. Falls back to sales_reps.email.';

-- A rep merges {rep_name} / {rep_email} into the draft before sending, so they
-- need to read their own roster row. Their own only - the table otherwise stays
-- service-role, and nobody sees the rest of the team.
DROP POLICY IF EXISTS "sales_reps_select_self" ON public.sales_reps;
CREATE POLICY "sales_reps_select_self" ON public.sales_reps
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ── 2. The templates ────────────────────────────────────────────────────────
-- Two rows, keyed by kind. Shared across the team; only full users may edit.
CREATE TABLE IF NOT EXISTS public.sales_email_templates (
  kind       text PRIMARY KEY CHECK (kind IN ('info','followup')),
  subject    text NOT NULL DEFAULT '',
  body       text NOT NULL DEFAULT '',
  updated_at timestamptz,
  updated_by uuid
);

COMMENT ON TABLE public.sales_email_templates IS
  'Sales info + follow-up email templates. Placeholders: {first_name}, {company_name}, {rep_name}, {rep_email}.';

INSERT INTO public.sales_email_templates (kind, subject, body) VALUES
('info',
 'Your lead system, {company_name}',
 E'Hi {first_name},\n\nThanks for your time today. As promised, here is a rundown of what we do at QuoteLeads.\n\nWe build a branded lead generation system into your business - campaigns, a landing page and survey funnel, tracking, AI SMS follow-up and a CRM pipeline - all on your own ad accounts, in your name, and yours to keep.\n\nThe short version:\n\n  - Built and live in 24 to 48 hours\n  - Every enquiry texted back within 60 seconds\n  - Exclusive to you, never shared with competitors\n  - Ad spend goes direct to Meta from your own account, never through us\n  - 10 quoted jobs in your first 30 days, or your build fee back\n\nHappy to walk you through any part of it. Just reply here or give me a call.\n\n{rep_name}\nQuoteLeads'),
('followup',
 'Following up - {company_name}',
 E'Hi {first_name},\n\nJust circling back on the information I sent through.\n\nHappy to answer anything still open, or to talk through what the first 30 days would look like for {company_name} specifically.\n\nIf the timing is not right, tell me and I will leave it there.\n\n{rep_name}\nQuoteLeads')
ON CONFLICT (kind) DO NOTHING;

ALTER TABLE public.sales_email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sales_email_templates_select" ON public.sales_email_templates;
DROP POLICY IF EXISTS "sales_email_templates_write"  ON public.sales_email_templates;

-- Reps read them (the draft is merged in the browser); only full users write.
CREATE POLICY "sales_email_templates_select" ON public.sales_email_templates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "sales_email_templates_write" ON public.sales_email_templates
  FOR UPDATE TO authenticated
  USING (NOT public.is_sales_rep()) WITH CHECK (NOT public.is_sales_rep());

-- ── 3. Send tracking ────────────────────────────────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS info_sent_at      timestamptz,
  ADD COLUMN IF NOT EXISTS info_sent_by      uuid,
  ADD COLUMN IF NOT EXISTS followup_sent_at  timestamptz,
  ADD COLUMN IF NOT EXISTS followup_sent_by  uuid;

CREATE TABLE IF NOT EXISTS public.sales_email_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('info','followup')),
  to_email    text NOT NULL,
  reply_to    text,
  subject     text NOT NULL,
  body        text NOT NULL,
  sent_by     uuid,
  provider_id text,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_email_log_lead_idx ON public.sales_email_log (lead_id, sent_at DESC);

ALTER TABLE public.sales_email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sales_email_log_select" ON public.sales_email_log;
-- Full users see everything; a rep sees the history on leads they own. Writes
-- are service-role only (the edge function), so there is no insert policy.
CREATE POLICY "sales_email_log_select" ON public.sales_email_log
  FOR SELECT TO authenticated USING (
    NOT public.is_sales_rep()
    OR EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id AND l.owner_id = auth.uid())
  );
