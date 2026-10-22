-- avg_quarterly_bill arrives as free text from the lead form — e.g. "$300–$600",
-- "$1,000+", "More than $600" — but this column was numeric, so submit-lead's
-- parseFloat() silently turned every non-numeric answer into NULL and clients
-- never received it. Store it verbatim as text so it survives any format and is
-- delivered exactly as the homeowner entered it.
alter table public.ppl_leads
  alter column avg_quarterly_bill type text using avg_quarterly_bill::text;
