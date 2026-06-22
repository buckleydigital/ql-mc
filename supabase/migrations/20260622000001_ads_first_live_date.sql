-- Add ads_first_live_date column for managed advertising clients
-- When this date is set, next payment due = ads_first_live_date + 30 days (instead of last_payment_date + 30 days)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ads_first_live_date date DEFAULT NULL;
