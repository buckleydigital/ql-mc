-- Cost cut-off for pay-per-lead orders.
--
-- ppl_order_log.max_cpl is the most an outstanding order can bear per lead
-- before it stops making money. meta-cost-check compares each campaign's
-- recent cost per lead against the orders it feeds: past an order's max, the
-- order is flagged (cpl_breached_at); past the max of every outstanding order
-- on the campaign, the campaign is paused in Meta and marked cost_paused.
--
-- A cost pause sticks until someone resumes the campaign from MC
-- (meta-campaign-toggle clears it), because a paused campaign stops spending
-- and its recent cost per lead would otherwise look fine again and resume it.

alter table public.ppl_order_log
  add column if not exists max_cpl numeric(10,2),
  add column if not exists cpl_breached_at timestamptz;

alter table public.meta_campaigns
  add column if not exists cost_paused boolean not null default false,
  add column if not exists cost_paused_at timestamptz,
  add column if not exists cost_pause_reason text,
  add column if not exists spend_3d numeric(10,2),
  add column if not exists leads_3d integer,
  add column if not exists cpl_3d numeric(10,2),
  add column if not exists cost_checked_at timestamptz;

-- The default for orders with no max_cpl of their own: this percentage of the
-- order's $/lead ex GST (lead_price includes GST). Blank turns the default off, leaving those orders unlimited.
alter table public.business_settings
  add column if not exists default_max_cpl_pct numeric(5,2) default 70;
