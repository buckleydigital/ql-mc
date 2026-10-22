-- The pipeline's "follow-up due" flag, ticked off from the card: the follow-up
-- is logged as a contact now and any set follow-up date is cleared, so the
-- flag goes until the lead next goes FOLLOWUP_STALE_DAYS without contact.
-- Reps can't update leads directly, so this runs as definer: a rep may tick
-- off their own leads, the rest of the team any lead.
create or replace function public.mark_followup_done(p_lead uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  update public.leads
     set last_contact = now(),
         contact_count = coalesce(contact_count, 0) + 1,
         next_followup = null,
         updated_at = now()
   where id = p_lead
     and (not public.is_sales_rep() or owner_id = auth.uid());
  if not found then
    raise exception 'lead not found or not yours';
  end if;
end;
$$;

revoke all on function public.mark_followup_done(uuid) from public, anon;
grant execute on function public.mark_followup_done(uuid) to authenticated;
