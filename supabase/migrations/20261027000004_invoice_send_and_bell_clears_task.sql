-- 1. Sending invoices from the Invoices screen (send-invoice edge function):
--    when and to whom each one went.
alter table public.invoices add column if not exists sent_at timestamptz;
alter table public.invoices add column if not exists sent_to text;

-- 2. Clearing a billing reminder on the bell ticks its task done - the other
--    half of tasks_billing_clears_bell. That trigger then finds the bell key
--    already in dismissed_alerts, inserts nothing, and the loop stops there.
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
    update tasks
       set done = true, updated_at = now()
     where auto_key = case when new.key like 'perf:%' then 'report:' || substr(new.key, 6) else new.key end
       and done is not true;
  end if;
  return new;
end;
$$;

create or replace trigger dismissed_alerts_clears_billing_task
  after insert on public.dismissed_alerts
  for each row
  execute function public.bell_clears_billing_task();
