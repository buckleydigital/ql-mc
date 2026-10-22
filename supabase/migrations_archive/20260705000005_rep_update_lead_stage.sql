-- Allow sales reps to change ONLY the pipeline stage of leads they own.
--
-- Reps are otherwise view-only on leads (see 20260705000002): the table's
-- UPDATE policy blocks them entirely, which is deliberate — RLS is row-level,
-- so it can't by itself permit "stage only" while forbidding every other
-- column. This SECURITY DEFINER function is the narrow, audited exception:
-- it updates just stage (+ the auto-contactable flag and updated_at) after
-- verifying the caller is a rep who owns the lead. The blanket UPDATE lock on
-- the table stays in force, so reps still can't craft arbitrary column writes.

create or replace function public.rep_update_lead_stage(p_lead_id uuid, p_stage text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  -- Reps only. Full users update leads directly (and this adds nothing for them).
  if not public.is_sales_rep() then
    raise exception 'rep_update_lead_stage is for sales reps only';
  end if;

  -- A rep may only move a lead assigned to them.
  select owner_id into v_owner from public.leads where id = p_lead_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'not authorised for this lead';
  end if;

  -- Constrain to the known pipeline stages (the kanban drop targets).
  if p_stage not in (
    'new_lead','no_answer','call_back','proposal','closed_won','closed_lost'
  ) then
    raise exception 'invalid stage: %', p_stage;
  end if;

  -- Mirror the auto-contactable behaviour the UI applies on these stages.
  update public.leads
     set stage       = p_stage,
         contactable  = case when p_stage in ('call_back','proposal','closed_won')
                             then true else contactable end,
         updated_at   = now()
   where id = p_lead_id;
end;
$$;

revoke all on function public.rep_update_lead_stage(uuid, text) from public;
grant execute on function public.rep_update_lead_stage(uuid, text) to authenticated;
