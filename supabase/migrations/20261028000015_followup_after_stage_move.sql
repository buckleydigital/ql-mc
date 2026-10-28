-- Moving a lead on means someone just worked it, so it is not due for a
-- follow-up the same day.
--
-- Website leads arrive with today as their follow-up date. Ringing one and
-- moving it to Proposal left that date in place, so the dashboard counted it
-- as needing follow-up minutes after the call. Now, when a lead moves to an
-- open stage and its follow-up date is today or already past, the date moves
-- forward: 2 days for Proposal (time to read the offer), 1 day otherwise.
-- A follow-up date set in the same save is left exactly as chosen.
create or replace function public.leads_push_followup()
returns trigger language plpgsql as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
begin
  if new.stage is distinct from old.stage
     and new.stage in ('new_lead', 'no_answer', 'call_back', 'proposal')
     and new.next_followup is not distinct from old.next_followup
     and new.next_followup <= today then
    new.next_followup := today + case when new.stage = 'proposal' then 2 else 1 end;
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'leads_push_followup' and tgrelid = 'public.leads'::regclass) then
    create trigger leads_push_followup before update of stage on public.leads
      for each row execute function public.leads_push_followup();
  end if;
end $$;

-- Leads already moved today with today's date still on them.
update public.leads
   set next_followup = (now() at time zone 'Australia/Sydney')::date + case when stage = 'proposal' then 2 else 1 end
 where stage in ('no_answer', 'call_back', 'proposal')
   and next_followup = (now() at time zone 'Australia/Sydney')::date
   and (stage_changed_at at time zone 'Australia/Sydney')::date = (now() at time zone 'Australia/Sydney')::date
   and (created_at at time zone 'Australia/Sydney')::date = (now() at time zone 'Australia/Sydney')::date;
