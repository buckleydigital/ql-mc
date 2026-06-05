-- Add HVAC/aircon-specific columns to the leads table so the direct REST
-- insert from airconnow.online (and similar multi-niche forms) can store
-- all submitted fields without hitting "column does not exist" errors.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS is_decision_maker boolean,
  ADD COLUMN IF NOT EXISTS ac_type           text,
  ADD COLUMN IF NOT EXISTS ownership_type    text,
  ADD COLUMN IF NOT EXISTS matched_buyer     text,
  ADD COLUMN IF NOT EXISTS consent_text      text,
  ADD COLUMN IF NOT EXISTS submitted_at      timestamptz;

-- Also ensure the anon role can insert into leads so the form's direct
-- REST insert works (currently blocked by the authenticated-only policy).
-- We use a separate policy scoped to INSERT only so reads remain protected.
DROP POLICY IF EXISTS "anon_insert" ON public.leads;
CREATE POLICY "anon_insert" ON public.leads
  FOR INSERT TO anon WITH CHECK (true);
