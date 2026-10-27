-- Monthly churn needs two dates per client: when they became a client and when
-- they were lost. Neither was stored (only the current stage), so the
-- dashboards could show nothing better than churned ÷ everyone ever.
--
--   client_since  the day they became a client
--   churned_at    the day they were moved to "churned", stamped then;
--                 cleared if they come back
--
-- Churn for a month = clients lost that month who were clients at its start,
-- ÷ clients at its start, × 100. Paused clients are still clients.

alter table public.clients
  add column if not exists client_since date,
  add column if not exists churned_at date;

create or replace function public.clients_stamp_churn()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
begin
  if tg_op = 'INSERT' and new.client_since is null then
    new.client_since := least(coalesce(new.start_date, today), today);
  end if;
  -- The day they're moved to churned is the day they churned. Only the date
  -- of someone already churned can be corrected by hand.
  if new.stage = 'churned' and (tg_op = 'INSERT' or old.stage is distinct from 'churned') then
    new.churned_at := today;
  elsif new.stage = 'churned' then
    new.churned_at := coalesce(new.churned_at, today);
  else
    new.churned_at := null;
  end if;
  return new;
end $$;

drop trigger if exists clients_stamp_churn on public.clients;
create trigger clients_stamp_churn
  before insert or update of stage, churned_at, client_since on public.clients
  for each row execute function public.clients_stamp_churn();

-- ── Backfill: clients churned before this have no record of when they were
-- moved, so their date is the best one their history gives (editable on the
-- client).
-- Managed: lost at the end of their last management period, the payment date
-- they didn't pay (else 30 days after the last one they did, else 30 days
-- after they started). Pay-per-lead has no period: lost after their last lead
-- (or order).
with ppl as (
  select c.id,
         least((select min(o.created_at)::date from ppl_order_log o where o.client_id = c.id),
               (select min(d.created_at)::date from lead_delivery_log d where d.client_id = c.id),
               c.start_date, c.created_at::date) as since,
         greatest((select max(o.created_at)::date from ppl_order_log o where o.client_id = c.id),
                  (select max(d.created_at)::date from lead_delivery_log d where d.client_id = c.id),
                  c.last_lead_delivered_at::date) as last_seen
    from clients c where c.type = 'ppl'
)
update clients c
   set client_since = coalesce(c.client_since, ppl.since),
       churned_at = case when c.stage = 'churned'
                         then coalesce(c.churned_at, greatest(ppl.since, least(coalesce(ppl.last_seen, ppl.since), current_date))) end
  from ppl where ppl.id = c.id;

with mg as (
  select c.id,
         least(c.start_date, c.ads_first_live_date, c.created_at::date) as since,
         coalesce(c.next_payment_date, c.last_payment_date + 30, least(c.start_date, c.ads_first_live_date, c.created_at::date) + 30) as lost
    from clients c where c.type <> 'ppl'
)
update clients c
   set client_since = coalesce(c.client_since, mg.since),
       churned_at = case when c.stage = 'churned'
                         then coalesce(c.churned_at, greatest(mg.since, least(mg.lost, current_date))) end
  from mg where mg.id = c.id;
