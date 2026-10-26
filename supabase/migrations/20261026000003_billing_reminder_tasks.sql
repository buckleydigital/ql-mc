-- Billing reminders for managed clients, as tasks on the Tasks panel:
--   7 days before next_payment_date  "Prepare invoice - <client>"
--   on next_payment_date             "Prepare performance report - <client>"
-- The notification tray shows the same two reminders (index.html, loadAlerts).
--
-- auto_key makes each reminder once only per client per payment date, and is
-- kept apart from linked_ref because editing a task rewrites linked_ref.
-- Catch-up windows (the rest of the 7 days for the invoice, 3 days for the
-- report) mean a missed run or a date set late still produces the task.
-- Only managed clients in the active stage carry a next_payment_date.

alter table public.tasks add column if not exists auto_key text;
create unique index if not exists tasks_auto_key_key on public.tasks (auto_key) where auto_key is not null;

create or replace function public.create_billing_reminder_tasks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  made integer := 0;
  n integer;
begin
  insert into tasks (title, assigned_to, priority, notes, due_date, linked_ref, linked_name, auto_key)
  select 'Prepare invoice - ' || coalesce(c.company_name, 'client'), 'human', 'normal',
         'Next payment due ' || to_char(c.next_payment_date, 'FMDD Mon YYYY')
           || coalesce('. Management fee $' || trim(to_char(c.management_fee, 'FM999,990.##')) || '/mo.', '.'),
         c.next_payment_date - 7, 'client:' || c.id, c.company_name,
         'invoice:' || c.id || ':' || c.next_payment_date
    from clients c
   where c.type = 'managed' and c.stage = 'active' and c.next_payment_date is not null
     and today between c.next_payment_date - 7 and c.next_payment_date
  on conflict (auto_key) where auto_key is not null do nothing;
  get diagnostics n = row_count; made := made + n;

  insert into tasks (title, assigned_to, priority, notes, due_date, linked_ref, linked_name, auto_key)
  select 'Prepare performance report - ' || coalesce(c.company_name, 'client'), 'human', 'normal',
         'Payment date ' || to_char(c.next_payment_date, 'FMDD Mon YYYY') || '. Send the client their performance report for the month.',
         c.next_payment_date, 'client:' || c.id, c.company_name,
         'report:' || c.id || ':' || c.next_payment_date
    from clients c
   where c.type = 'managed' and c.stage = 'active' and c.next_payment_date is not null
     and today between c.next_payment_date and c.next_payment_date + 3
  on conflict (auto_key) where auto_key is not null do nothing;
  get diagnostics n = row_count; made := made + n;

  return made;
end;
$$;

revoke all on function public.create_billing_reminder_tasks() from public, anon, authenticated;

-- 7:05am Sydney daylight time (6:05am standard), daily.
select cron.schedule('billing-reminder-tasks', '5 20 * * *', $$ select public.create_billing_reminder_tasks(); $$);
