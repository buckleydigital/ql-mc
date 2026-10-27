-- Deleting a billing reminder task (or ticking it done) clears the matching
-- reminder on the notification bell, so it only has to be cleared once.
--
-- The bell builds these reminders from each client's payment date
-- (index.html, buildAlertItems) and hides any whose key is in
-- dismissed_alerts. The task's auto_key carries the same client and date:
--   invoice:<client>:<date>  ->  bell key invoice:<client>:<date>
--   report:<client>:<date>   ->  bell key perf:<client>:<date>

create or replace function public.billing_task_clears_bell()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  k text := coalesce(old.auto_key, '');
begin
  if tg_op = 'UPDATE' and not (new.done is true and old.done is not true) then
    return new;
  end if;
  if k like 'invoice:%' or k like 'report:%' then
    insert into dismissed_alerts (key, dismissed_by)
    values (case when k like 'report:%' then 'perf:' || substr(k, 8) else k end, auth.uid())
    on conflict (key) do nothing;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace trigger tasks_billing_clears_bell
  after delete or update of done on public.tasks
  for each row when (old.auto_key is not null)
  execute function public.billing_task_clears_bell();
