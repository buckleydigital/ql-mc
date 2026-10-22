-- Restrict the clients table so sales_rep accounts cannot read it.
--
-- Background: clients_authenticated_read (20260422) granted SELECT to every
-- authenticated user with USING (true). Sales reps authenticate as the same
-- `authenticated` role, so that policy also exposed the full client book to
-- them — including clients.hq_bearer_token (live HQ API credentials), pricing,
-- caps and contact details. A rep with their JWT + the anon key could read the
-- whole table straight from the REST API, regardless of what the panel shows.
--
-- Fix: scope the read to full users only. Reps get zero rows.
--   • Edge Functions use the service-role key, which BYPASSES RLS entirely —
--     submit-lead, deliver-webhook, etc. are unaffected.
--   • Full (non-rep) users still pass not public.is_sales_rep() → unchanged.
--   • There are no INSERT/UPDATE/DELETE policies on clients, so writes already
--     only happen via service-role functions — nothing else to change.

DROP POLICY IF EXISTS "clients_authenticated_read" ON public.clients;

CREATE POLICY "clients_full_users_read" ON public.clients
  FOR SELECT TO authenticated
  USING (NOT public.is_sales_rep());
