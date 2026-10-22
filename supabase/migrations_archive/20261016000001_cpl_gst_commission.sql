-- Pay-per-lead cost cut-off: GST and commission treatment.
--
-- The cut-off (maxCplFor) now works from the lead cost listed, which by
-- default EXCLUDES GST. Commission is calculated on revenue ex-GST by
-- default, so a 15% commission on a $100 lead costs $15, not $15 + GST.
-- The business-level defaults below flip that behaviour per business.
--
--   price ex-GST by default (price_includes_gst = false):
--     revenue = price, gross = price x (1 + gst rate)
--   price inc GST (price_includes_gst = true):
--     revenue = price / (1 + gst rate), gross = price
--   commission = commission base x rep commission %,
--     commission base = revenue ex-GST by default ('ex'), or gross incl GST ('inc')
--   max CPL = (revenue - commission - stripe - margin kept) / (1 + dud rate)

alter table public.business_settings
  add column if not exists gst_rate_pct numeric(5,2) not null default 10,
  add column if not exists price_includes_gst boolean not null default false,
  add column if not exists rep_commission_pct numeric(5,2) not null default 15,
  add column if not exists commission_base text not null default 'ex'
    check (commission_base in ('ex', 'inc')),
  add column if not exists stripe_fee_fixed numeric(10,2) not null default 0.30;

comment on column public.business_settings.gst_rate_pct is 'GST rate used to split the listed lead price into revenue ex-GST and GST';
comment on column public.business_settings.price_includes_gst is 'When true the listed lead price includes GST; when false (default) it is ex-GST';
comment on column public.business_settings.rep_commission_pct is 'Sales rep commission %, applied to the commission base';
comment on column public.business_settings.commission_base is 'ex = revenue ex-GST (default), inc = customer payment including GST';
comment on column public.business_settings.stripe_fee_fixed is 'Fixed Stripe fee per lead charge, added to the percentage fee';
