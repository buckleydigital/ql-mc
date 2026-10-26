-- Continue invoice numbering from the last invoice issued outside this system
-- (#0255), so the next one is QL-INV-0256 and later ones carry on from the
-- highest number used. invoice_number_seq is only a fallback in
-- set_invoice_number (generate_invoice_number fires first and always sets the
-- number), but it is moved past 255 too so the two can never collide.
CREATE OR REPLACE FUNCTION public.generate_invoice_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  next_num integer;
BEGIN
  SELECT GREATEST(
    COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM 'QL-INV-(\d+)') AS integer)), 0) + 1,
    256
  ) INTO next_num FROM invoices;
  NEW.invoice_number := 'QL-INV-' || LPAD(next_num::text, 4, '0');
  RETURN NEW;
END;
$function$;

select setval('public.invoice_number_seq', greatest((select last_value from public.invoice_number_seq), 255));
