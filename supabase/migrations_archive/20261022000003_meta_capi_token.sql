-- Our own sales go to our pixel with a Conversions API token generated for it
-- in Events Manager (pixel > Settings > Conversions API > Generate access
-- token), not through our Meta app. The token lives in the vault as
-- 'meta_capi_token': the team saves it from Business Settings, only meta-capi
-- (service role) reads it.
create or replace function public.set_meta_capi_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret uuid;
begin
  if auth.role() <> 'service_role' and (auth.uid() is null or public.is_sales_rep()) then
    raise exception 'not allowed';
  end if;
  select id into v_secret from vault.secrets where name = 'meta_capi_token';
  if v_secret is null then
    perform vault.create_secret(coalesce(p_token, ''), 'meta_capi_token');
  else
    perform vault.update_secret(v_secret, coalesce(p_token, ''));
  end if;
end;
$$;

create or replace function public.get_meta_capi_token()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(decrypted_secret, '') from vault.decrypted_secrets where name = 'meta_capi_token'
$$;

revoke all on function public.set_meta_capi_token(text) from public, anon;
grant execute on function public.set_meta_capi_token(text) to authenticated, service_role;
revoke all on function public.get_meta_capi_token() from public, anon, authenticated;
grant execute on function public.get_meta_capi_token() to service_role;
