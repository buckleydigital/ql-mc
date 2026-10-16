-- Pay-per-lead orders: per-order rep commission override.
--
-- rep_commission_pct / commission_base are nullable: when set they override the
-- business_settings default for that order's cost cut-off; when null the
-- business_settings values (which themselves default to ex-GST / 15%) apply.
-- This lets an order opt out of rep commission entirely (set to 0) or use a
-- different rate/base than the business default.

alter table public.ppl_order_log
  add column if not exists rep_commission_pct numeric(5,2),
  add column if not exists commission_base text
    check (commission_base in ('ex', 'inc'));

comment on column public.ppl_order_log.rep_commission_pct is 'Per-order rep commission %, null = fall back to business_settings.rep_commission_pct';
comment on column public.ppl_order_log.commission_base is 'Per-order commission base, null = fall back to business_settings.commission_base';
