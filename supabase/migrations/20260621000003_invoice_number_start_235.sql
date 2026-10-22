-- Move the invoice number sequence so the next generated number is INV-0235.
-- If the sequence already exists, set its last_value to 234 (next call → 235).
-- If it doesn't exist yet, create it starting at 235.
do $$
begin
  if exists (
    select 1 from pg_sequences
    where schemaname = 'public' and sequencename = 'invoice_number_seq'
  ) then
    perform setval('public.invoice_number_seq', 234, true);
  else
    create sequence public.invoice_number_seq start with 235 increment by 1;
  end if;
end;
$$;

-- Recreate the trigger function so it is definitely wired to the sequence above.
create or replace function public.set_invoice_number()
returns trigger
language plpgsql
as $$
begin
  if NEW.invoice_number is null then
    NEW.invoice_number := 'INV-' || lpad(nextval('public.invoice_number_seq')::text, 4, '0');
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_set_invoice_number on public.invoices;
create trigger trg_set_invoice_number
  before insert on public.invoices
  for each row execute function public.set_invoice_number();
