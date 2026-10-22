-- A managed client in the active stage is "Ads Live" unless someone has chosen
-- another ad status. Done in the database so it holds however the client got to
-- active: the edit modal, a drag on the board, or a sync from ql-hq.
create or replace function public.managed_active_default_ads_live()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.type = 'managed' and new.stage = 'active'
     and (new.active_status is null or new.active_status = '') then
    new.active_status := 'Ads Live';
  end if;
  return new;
end;
$$;

drop trigger if exists managed_active_default_ads_live on public.clients;
create trigger managed_active_default_ads_live
  before insert or update of stage, active_status, type on public.clients
  for each row execute function public.managed_active_default_ads_live();
