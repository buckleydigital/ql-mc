-- Billing runs in 30-day periods from day 1 (the day the ads went live).
--
-- next_payment_date was only ever typed in by hand, so the invoice reminder
-- fired once and then never again. The daily job now moves it on by 30 days
-- once a payment date and its report window have passed, and a drafted
-- invoice covers the 30 days from its payment date rather than a calendar
-- month, so periods never drift or overlap.

create or replace function public.create_billing_reminder_tasks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Australia/Sydney')::date;
  biz_notes text := (select default_notes from business_settings limit 1);
  made integer := 0;
  n integer;
  inv_no text;
  r record;
begin
  -- Management runs in 30-day periods from the day the ads went live. Once a
  -- payment date (and its 3-day report window) has passed, move it on to the
  -- next period, so the reminder and the draft come round again every 30
  -- days instead of only when someone retypes the date.
  update clients c
     set next_payment_date = c.next_payment_date + 30 * (((today - 4) - c.next_payment_date) / 30 + 1),
         updated_at = now()
   where c.type = 'managed' and c.stage = 'active' and c.next_payment_date is not null
     and c.next_payment_date <= today - 4;

  for r in
    select 'invoice' as kind, c.id, c.company_name, c.email, c.niche, c.management_fee as fee, c.next_payment_date as pay_date,
           'Prepare invoice - ' || coalesce(c.company_name, 'client') as title,
           'Next payment due ' || to_char(c.next_payment_date, 'FMDD Mon YYYY')
             || coalesce('. Management fee $' || trim(to_char(c.management_fee, 'FM999,990.##')) || '/mo.', '.') as notes,
           c.next_payment_date - 7 as due_date,
           'invoice:' || c.id || ':' || c.next_payment_date as auto_key
      from clients c
     where c.type = 'managed' and c.stage = 'active' and c.next_payment_date is not null
       and today between c.next_payment_date - 7 and c.next_payment_date
    union all
    select 'report', c.id, c.company_name, c.email, c.niche, c.management_fee, c.next_payment_date,
           'Prepare performance report - ' || coalesce(c.company_name, 'client'),
           'Payment date ' || to_char(c.next_payment_date, 'FMDD Mon YYYY') || '. Send the client their performance report for the month.',
           c.next_payment_date,
           'report:' || c.id || ':' || c.next_payment_date
      from clients c
     where c.type = 'managed' and c.stage = 'active' and c.next_payment_date is not null
       and today between c.next_payment_date and c.next_payment_date + 3
  loop
    -- Claimed once, ever: deleting the task or the draft never brings it back.
    insert into billing_reminders_sent (auto_key) values (r.auto_key) on conflict do nothing;
    get diagnostics n = row_count;
    continue when n = 0;

    inv_no := null;
    if r.kind = 'invoice' and coalesce(r.fee, 0) > 0 then
      insert into invoices (client_id, client_name, client_email, offer_type, vertical,
                            delivery_period_start, delivery_period_end, line_items,
                            subtotal, gst_type, gst_amount, total, notes, status, invoice_date, due_date)
      values (r.id, r.company_name, coalesce(r.email, ''), 'managed', coalesce(r.niche, ''),
              r.pay_date, r.pay_date + 29,
              jsonb_build_array(jsonb_build_object('description', 'Managed Advertising - Monthly Retainer',
                                                   'qty', 1, 'unit_price', round(r.fee / 1.1, 2), 'line_total', round(r.fee / 1.1, 2))),
              round(r.fee / 1.1, 2), 'exclusive', round(round(r.fee / 1.1, 2) * 0.1, 2),
              round(r.fee / 1.1, 2) + round(round(r.fee / 1.1, 2) * 0.1, 2), biz_notes, 'draft', today, r.pay_date)
      returning invoice_number into inv_no;
    end if;

    insert into tasks (title, assigned_to, priority, notes, due_date, linked_ref, linked_name, auto_key)
    values (r.title, 'human', 'normal',
            r.notes || coalesce(' Draft invoice ' || inv_no || ' is ready in Invoices: review it, then download and send.', ''),
            r.due_date, 'client:' || r.id, r.company_name, r.auto_key)
    on conflict (auto_key) where auto_key is not null do nothing;
    made := made + 1;
  end loop;

  return made;
end;
$$;

revoke all on function public.create_billing_reminder_tasks() from public, anon, authenticated;
