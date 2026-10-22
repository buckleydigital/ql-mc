-- ════════════════════════════════════════════════════════════════════════════
-- Hiring pipeline
--
-- The recruitment counterpart to the sales pipeline: one kanban board of
-- candidates moving Applied → Screening → Interview → Offer → Hired, with
-- Rejected as the closed-lost column.
--
-- It gets its own table rather than another `type` on leads. A candidate and a
-- prospect share almost no fields (salary and availability vs deal value and
-- lead type), and every rep-scoping policy on leads would have to grow an
-- exception for rows that are not leads at all.
--
-- Visibility: full internal users only. Sales reps are walled off exactly the
-- way they are from finance and clients - is_sales_rep() already exists for
-- that (see 20260618000001_sales_reps.sql) and service-role bypasses RLS.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.hiring_candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  email           text,
  phone           text,
  role            text,
  stage           text NOT NULL DEFAULT 'applied'
                    CHECK (stage IN ('applied','screening','interview','offer','hired','rejected')),
  source          text,
  expected_salary numeric,
  available_from  date,
  resume_url      text,
  rating          integer CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10)),
  next_followup   date,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz
);

COMMENT ON TABLE  public.hiring_candidates          IS 'Hiring pipeline - one row per candidate.';
COMMENT ON COLUMN public.hiring_candidates.rating   IS 'Internal 0-10 score, same scale as client CX.';
COMMENT ON COLUMN public.hiring_candidates.role     IS 'Role applied for, free text.';

CREATE INDEX IF NOT EXISTS hiring_candidates_stage_idx
  ON public.hiring_candidates (stage);
CREATE INDEX IF NOT EXISTS hiring_candidates_followup_idx
  ON public.hiring_candidates (next_followup)
  WHERE next_followup IS NOT NULL;

ALTER TABLE public.hiring_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hiring_candidates_select" ON public.hiring_candidates;
DROP POLICY IF EXISTS "hiring_candidates_insert" ON public.hiring_candidates;
DROP POLICY IF EXISTS "hiring_candidates_update" ON public.hiring_candidates;
DROP POLICY IF EXISTS "hiring_candidates_delete" ON public.hiring_candidates;

CREATE POLICY "hiring_candidates_select" ON public.hiring_candidates
  FOR SELECT TO authenticated USING (NOT public.is_sales_rep());
CREATE POLICY "hiring_candidates_insert" ON public.hiring_candidates
  FOR INSERT TO authenticated WITH CHECK (NOT public.is_sales_rep());
CREATE POLICY "hiring_candidates_update" ON public.hiring_candidates
  FOR UPDATE TO authenticated
  USING (NOT public.is_sales_rep()) WITH CHECK (NOT public.is_sales_rep());
CREATE POLICY "hiring_candidates_delete" ON public.hiring_candidates
  FOR DELETE TO authenticated USING (NOT public.is_sales_rep());
