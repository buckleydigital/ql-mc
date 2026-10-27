-- Clearing a billing reminder on the bell deletes its task, rather than
-- leaving it ticked and crossed out in the task list. (Ticking a task by hand
-- still just marks it done.) billing_reminders_sent stops the morning job
-- making a deleted one again, and the task's own delete trigger finds the bell
-- key already cleared, so nothing loops.
--   bell invoice:<client>:<date>  ->  task invoice:<client>:<date>
--   bell perf:<client>:<date>     ->  task report:<client>:<date>
create or replace function public.bell_clears_billing_task()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.key like 'invoice:%' or new.key like 'perf:%' then
    delete from tasks
     where auto_key = case when new.key like 'perf:%' then 'report:' || substr(new.key, 6) else new.key end;
  end if;
  return new;
end;
$$;
