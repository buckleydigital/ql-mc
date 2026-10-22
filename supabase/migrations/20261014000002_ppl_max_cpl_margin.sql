-- The default max cost per lead for orders without their own max_cpl, worked
-- out from the margin we need rather than a flat percentage:
--
--   max CPL = (price / 1.1 x (1 - margin) - price x stripe fee) / (1 + dud rate)
--
-- price is the order's $/lead including GST, margin is what has to be left of
-- the price ex GST, dud rate is the extra leads given away as replacements,
-- and the Stripe fee is taken on the full charge. A blank margin turns the
-- default off, leaving those orders unlimited. This replaces
-- default_max_cpl_pct, which is no longer read.

alter table public.business_settings
  add column if not exists target_margin_pct numeric(5,2) default 30,
  add column if not exists dud_rate_pct numeric(5,2) not null default 12,
  add column if not exists stripe_fee_pct numeric(5,2) not null default 1.75;
