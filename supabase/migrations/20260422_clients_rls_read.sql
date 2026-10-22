-- Ensure authenticated users can read the clients table so that PostgREST can
-- resolve the leads→clients foreign-key join used in the leads dashboard
-- (select=status,niche,assigned_client_id,clients(company_name)).
--
-- Without this policy the REST API returns HTTP 400 "Could not find a
-- relationship …" or a permission error when the join is attempted.

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read client rows.  Write operations are
-- still controlled by existing policies (or the service-role key used in
-- Edge Functions).
DROP POLICY IF EXISTS "clients_authenticated_read" ON clients;
CREATE POLICY "clients_authenticated_read" ON clients
  FOR SELECT TO authenticated
  USING (true);
