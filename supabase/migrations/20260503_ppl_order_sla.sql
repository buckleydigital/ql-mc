-- Add SLA tracking columns to ppl_order_log.
-- purchase_date: when the client paid / order was confirmed (defaults to order_date).
-- sla_due_date:  deadline by which all leads must be delivered.

ALTER TABLE ppl_order_log
  ADD COLUMN IF NOT EXISTS purchase_date date,
  ADD COLUMN IF NOT EXISTS sla_due_date  date;

-- Back-fill purchase_date from order_date for existing rows
UPDATE ppl_order_log SET purchase_date = order_date WHERE purchase_date IS NULL AND order_date IS NOT NULL;

-- RLS already inherited from the table-level policy; no extra grants needed.
