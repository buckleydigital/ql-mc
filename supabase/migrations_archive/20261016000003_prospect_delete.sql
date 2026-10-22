-- Cold outreach: remove a prospect that has been found but not yet pushed to
-- a campaign. Prospects already pushed to Instantly (instantly_pushed_at set)
-- cannot be deleted here - they are already in a campaign and must be paused
-- or unsubscribed from instead. Anything that has been contacted or converted
-- is history and cannot be removed.
create or replace function public.prospect_delete(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  perform public.jarvis_assert_operator();

  select p.* into r
    from public.prospects p
   where p.id = p_id;

  if not found then
    raise exception 'No such prospect' using errcode = '22023';
  end if;

  if r.instantly_pushed_at is not null then
    raise exception 'Already pushed to a campaign - cannot delete' using errcode = '22023';
  end if;

  if r.status in ('contacted', 'replied', 'interested', 'not_interested', 'unsubscribed', 'bounced', 'converted') then
    raise exception 'Already contacted or converted - cannot delete' using errcode = '22023';
  end if;

  delete from public.prospects where id = p_id;

  return jsonb_build_object('ok', true, 'deleted', p_id);
end;
$$;

revoke all on function public.prospect_delete(uuid) from public, anon, authenticated;
grant execute on function public.prospect_delete(uuid) to authenticated;
