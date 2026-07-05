-- Make sales reps VIEW-ONLY on the leads pipeline.
--
-- Previously reps could update/insert their own leads (owner_id = auth.uid()).
-- Business now wants reps to read their pipeline but never mutate it. Deletes
-- were already blocked. Full users and service-role edge functions are
-- unaffected (service-role bypasses RLS entirely).
--
-- SELECT stays scoped to their own rows; INSERT/UPDATE become full-user-only.

DROP POLICY IF EXISTS "leads_insert" ON public.leads;
CREATE POLICY "leads_insert" ON public.leads FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_sales_rep());

DROP POLICY IF EXISTS "leads_update" ON public.leads;
CREATE POLICY "leads_update" ON public.leads FOR UPDATE TO authenticated
  USING (NOT public.is_sales_rep())
  WITH CHECK (NOT public.is_sales_rep());

-- leads_select and leads_delete are already correct:
--   select: (NOT is_sales_rep() OR owner_id = auth.uid())  → reps read own rows
--   delete: (NOT is_sales_rep())                           → reps cannot delete
