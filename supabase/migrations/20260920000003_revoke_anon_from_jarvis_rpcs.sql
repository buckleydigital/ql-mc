-- Take anon off the Jarvis RPCs.
--
-- Both were created with `revoke all ... from public`, which looked like it
-- removed anon and did not: Supabase grants EXECUTE directly to anon via
-- default privileges, and revoking from PUBLIC never removes a direct grant.
-- So the grant said anon could call them all along.
--
-- Neither is actually exploitable - both raise 42501 in the body when
-- auth.jwt() is null, which is verified - but "the body catches it" is one
-- layer, and the grant is the layer that should never have let the call
-- through in the first place. Defence in depth means both, not either.
revoke execute on function public.jarvis_status() from anon;
revoke execute on function public.jarvis_action_log(int) from anon;
