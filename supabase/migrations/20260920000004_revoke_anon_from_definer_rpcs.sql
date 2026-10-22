-- Take anon off five SECURITY DEFINER functions that had no auth check at all.
--
-- These run with the definer's privileges and bypass RLS, and EXECUTE was
-- granted to PUBLIC - so anyone holding the publishable anon key, which is
-- public by design and sits in the page source, could call them over
-- /rest/v1/rpc/. Unlike jarvis_status and jarvis_action_log, none of these
-- checks auth.jwt() in the body, so nothing stopped the call once it arrived.
--
-- Checked every caller first. All are the signed-in dashboard (authenticated)
-- or an edge function using the service role:
--
--   add_lead                  index.html - the Add Lead modal
--   mark_lead_scrubbed        sync-from-hq (service role) + the dashboard
--   increment_leads_delivered deliver-webhook, via supabaseAdmin
--   mark_lead_delivered       index.html - Mark Delivered
--   assign_solar_lead         no callers anywhere
--
-- REVOKE FROM PUBLIC, not just anon. Revoking the direct grant to anon alone
-- reported success and changed nothing, because anon still reached EXECUTE
-- through PUBLIC - Postgres grants it there on every new function. Then grant
-- back explicitly, or the same revoke would cut off the dashboard too.
revoke execute on function public.add_lead(text, text, text, text, text, text, numeric, text, text) from public, anon;
revoke execute on function public.mark_lead_scrubbed(uuid) from public, anon;
revoke execute on function public.increment_leads_delivered(uuid) from public, anon;
revoke execute on function public.mark_lead_delivered(uuid, text) from public, anon;
revoke execute on function public.assign_solar_lead(uuid, text) from public, anon;

grant execute on function public.add_lead(text, text, text, text, text, text, numeric, text, text) to authenticated, service_role;
grant execute on function public.mark_lead_scrubbed(uuid) to authenticated, service_role;
grant execute on function public.increment_leads_delivered(uuid) to authenticated, service_role;
grant execute on function public.mark_lead_delivered(uuid, text) to authenticated, service_role;
grant execute on function public.assign_solar_lead(uuid, text) to authenticated, service_role;
