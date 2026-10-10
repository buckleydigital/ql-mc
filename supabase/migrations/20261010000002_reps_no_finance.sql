-- Sales reps cannot read the money: client records, orders, revenue, spend,
-- expenses or goals.
--
-- Each of these tables carries a PERMISSIVE policy with USING (true) (or
-- auth.uid() is not null) for every signed-in user. Permissive policies are
-- OR-ed, so clients_full_users_read (NOT is_sales_rep()) never restricted
-- anyone - 20260915000002 recorded this and left it for a deliberate fix. A
-- rep with their own token could read every client's fees and every order,
-- which is everything Avg Client LTV is built from, straight from the API.
--
-- A RESTRICTIVE policy is AND-ed with the permissive ones, so this closes it
-- for reps without changing anything for full users:
--   - full users pass NOT is_sales_rep() and keep exactly what they had;
--   - edge functions use the service role, which bypasses RLS;
--   - the rep's panels (Sales Pipeline, Invoices, Messages) read none of
--     these tables, and their commission comes from a SECURITY DEFINER RPC.

do $$
declare t text;
begin
  foreach t in array array['clients', 'ppl_order_log', 'managed_order_log', 'revenue',
                           'expenses', 'campaign_spend_log', 'monthly_goals'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists no_sales_rep_money on public.%I', t);
    execute format(
      'create policy no_sales_rep_money on public.%I as restrictive for all to authenticated
         using (not public.is_sales_rep()) with check (not public.is_sales_rep())', t);
  end loop;
end $$;
