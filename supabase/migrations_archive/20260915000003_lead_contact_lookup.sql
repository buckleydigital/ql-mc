-- ════════════════════════════════════════════════════════════════════════════
-- Lead contact lookup, for the growth-onboarding spam gate
--
-- ql-hq asks "is this email or phone already in our sales pipeline?" before it
-- creates an account. Only ql-mc can answer, because the pipeline lives here.
--
-- WHY THIS IS A FUNCTION AND NOT A QUERY
--   Phone numbers are stored however they were typed: "0412 345 678",
--   "+61412345678", "61412345678". A match therefore has to compare DIGITS, not
--   strings, and that cannot be expressed as a PostgREST filter. Doing it in the
--   client meant fetching every lead and comparing in memory, which is both
--   wasteful and wrong - it silently stops matching past whatever row cap the
--   fetch used, so the gate would start holding genuine clients as the pipeline
--   grew. In SQL it is an exact comparison over the whole table, every time.
--
--   Matching on the last 9 digits ignores the country code and the leading zero,
--   so every Australian format of the same mobile lands on the same key.
--
-- SECURITY
--   Callable only by service_role. It is reached through sync-from-hq, which
--   already authenticates ql-hq with x-api-secret. It is SECURITY DEFINER so it
--   can read `leads` past the restrictive no_sales_rep policy, which is exactly
--   why EXECUTE is revoked from anon and authenticated: left callable it would
--   be a way for a signed-in rep, or anyone with the anon key, to enumerate the
--   pipeline by guessing contact details.
-- ════════════════════════════════════════════════════════════════════════════

-- Last 9 digits of whatever was typed. IMMUTABLE so it can back an index.
CREATE OR REPLACE FUNCTION public.phone_digits9(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
$$;

COMMENT ON FUNCTION public.phone_digits9(text) IS
  'Last 9 digits of a phone number, so 0412 345 678 and +61412345678 compare equal.';

-- Makes the phone arm of the gate an index lookup rather than a scan of leads.
CREATE INDEX IF NOT EXISTS leads_phone_digits9_idx
  ON public.leads (public.phone_digits9(phone))
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_email_lower_idx
  ON public.leads (lower(email))
  WHERE email IS NOT NULL;

-- Returns matching pipeline leads, with which field matched.
--
-- ANY stage counts, closed_lost included: the question is "do we know this
-- person", not "are they still an open opportunity". No stage filter on purpose.
CREATE OR REPLACE FUNCTION public.find_leads_by_contact(
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_limit int  DEFAULT 5
)
RETURNS TABLE (
  id         uuid,
  name       text,
  company    text,
  email      text,
  phone      text,
  stage      text,
  source     text,
  created_at timestamptz,
  matched_on text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH norm AS (
    SELECT nullif(lower(trim(coalesce(p_email, ''))), '')      AS e,
           nullif(public.phone_digits9(coalesce(p_phone, '')), '') AS d
  )
  SELECT l.id, l.name, l.company, l.email, l.phone, l.stage, l.source, l.created_at,
         -- Email is the stronger signal, so say so when both hit.
         CASE
           WHEN (SELECT e FROM norm) IS NOT NULL AND lower(l.email) = (SELECT e FROM norm)
             THEN 'email'
           ELSE 'phone'
         END AS matched_on
    FROM public.leads l, norm
   WHERE ((norm.e IS NOT NULL AND lower(l.email) = norm.e)
       OR (norm.d IS NOT NULL AND l.phone IS NOT NULL AND public.phone_digits9(l.phone) = norm.d))
   ORDER BY (CASE WHEN (SELECT e FROM norm) IS NOT NULL AND lower(l.email) = (SELECT e FROM norm) THEN 0 ELSE 1 END),
            l.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 5), 25));
$$;

COMMENT ON FUNCTION public.find_leads_by_contact(text, text, int) IS
  'Spam gate for ql-hq growth-onboarding: pipeline leads matching an email or phone, any stage. service_role only - it reads past no_sales_rep.';

-- service_role only. See the header: this is SECURITY DEFINER over `leads`, so
-- leaving it callable by anon/authenticated would make it a pipeline enumeration
-- endpoint for anyone holding the anon key.
REVOKE ALL ON FUNCTION public.find_leads_by_contact(text, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_leads_by_contact(text, text, int) FROM anon;
REVOKE ALL ON FUNCTION public.find_leads_by_contact(text, text, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.find_leads_by_contact(text, text, int) TO service_role;

-- phone_digits9 is a pure string helper over its argument, reads nothing, and
-- backs an index, so it stays executable. Nothing leaks through it.
GRANT EXECUTE ON FUNCTION public.phone_digits9(text) TO anon, authenticated, service_role;
