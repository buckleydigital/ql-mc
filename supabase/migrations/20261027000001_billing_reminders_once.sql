-- Billing reminder tasks came back after being deleted.
--
-- create_billing_reminder_tasks() relied on the task row itself (its auto_key)
-- to know a reminder had already been made. Deleting the task removed that
-- record, so the next morning's run, still inside the catch-up window, made it
-- again. Each reminder that has been made is now recorded here, apart from the
-- task, and a task is only created when its key is claimed for the first time.
-- Deleting or completing a task no longer brings it back.

create table if not exists public.billing_reminders_sent (
  auto_key text primary key,
  sent_at  timestamptz not null default now()
);
alter table public.billing_reminders_sent enable row level security;
revoke all on public.billing_reminders_sent from anon, authenticated;

-- Everything already made counts as sent, including tasks since deleted
-- (their keys are the same as the copies made again this morning).
insert into public.billing_reminders_sent (auto_key)
select auto_key from public.tasks where auto_key is not null
on conflict do nothing;

create or replace function public.create_billing_reminder_tasks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  made integer;
begin
  with due as (
    select 'Prepare invoice - ' || coalesce(c.company_name, 'client') as title,
           'Next payment due ' || to_char(c.next_payment_date, 'FMDD Mon YYYY')
             || coalesce('. Management fee $' || trim(to_char(c.management_fee, 'FM999,990.##')) || '/mo.', '.') as notes,
           c.next_payment_date - 7 as due_date, c.id, c.company_name,
           'invoice:' || c.id || ':' || c.next_payment_date as auto_key
      from clients c
     where c.type = 'managed' and c.stage = 'active' and c.next_payment_date is not null
       and today between c.next_payment_date - 7 and c.next_payment_date
    union all
    select 'Prepare performance report - ' || coalesce(c.company_name, 'client'),
           'Payment date ' || to_char(c.next_payment_date, 'FMDD Mon YYYY') || '. Send the client their performance report for the month.',
           c.next_payment_date, c.id, c.company_name,
           'report:' || c.id || ':' || c.next_payment_date
      from clients c
     where c.type = 'managed' and c.stage = 'active' and c.next_payment_date is not null
       and today between c.next_payment_date and c.next_payment_date + 3
  ),
  claimed as (
    insert into billing_reminders_sent (auto_key)
    select auto_key from due
    on conflict do nothing
    returning auto_key
  )
  insert into tasks (title, assigned_to, priority, notes, due_date, linked_ref, linked_name, auto_key)
  select d.title, 'human', 'normal', d.notes, d.due_date, 'client:' || d.id, d.company_name, d.auto_key
    from due d join claimed using (auto_key)
  on conflict (auto_key) where auto_key is not null do nothing;

  get diagnostics made = row_count;
  return made;
end;
$$;

revoke all on function public.create_billing_reminder_tasks() from public, anon, authenticated;
