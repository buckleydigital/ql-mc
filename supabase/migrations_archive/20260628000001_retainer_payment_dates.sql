-- Cash-basis retainer attribution for managed advertising clients.
-- Records the date each active retainer month was paid (i.e. toggled on),
-- so retainer revenue can be attributed to the month the payment was
-- received rather than the month the retainer covers. Stored as a JSON
-- string map of { "YYYY-MM" (covered month): "YYYY-MM-DD" (date paid) }
-- to mirror the existing text-encoded `active_months` column.
-- Months without an entry fall back to covered-month attribution (legacy rows).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS retainer_payment_dates text DEFAULT '{}';
