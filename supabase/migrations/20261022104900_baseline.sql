-- Baseline: the whole app schema as it stands in the live database, generated
-- from the catalog on 2026-10-22. It replaces the earlier migrations (kept in
-- supabase/migrations_archive for their notes), which never created the core
-- tables and couldn't rebuild the database. New changes go in new migrations
-- after this one.
--
-- Needs the Supabase platform schemas (auth, storage, vault, cron, net), and
-- these vault secrets, which aren't in the repo:
-- jarvis_service_key, meta_capi_token (set from Business Settings)
set check_function_bodies = off;
set search_path = public, extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists supabase_vault with schema vault;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ===== Sequences =====
create sequence if not exists public.invoice_number_seq as bigint increment 1 minvalue 1 maxvalue 9223372036854775807 start 235;

-- ===== Tables =====
create table public.ad_spend_daily (
  id uuid default gen_random_uuid() not null,
  date date not null,
  account_type text not null,
  account_id text,
  client_id uuid,
  spend numeric(10,2) default 0,
  impressions integer default 0,
  clicks integer default 0,
  leads integer default 0,
  cpl numeric(10,2),
  client_name text
);

alter table public.ad_spend_daily enable row level security;
create table public.agent_files (
  id uuid default gen_random_uuid() not null,
  agent text not null,
  filename text not null,
  content text,
  updated_at timestamp with time zone default now(),
  title text,
  description text
);

alter table public.agent_files enable row level security;
create table public.app_settings (
  key text not null,
  value text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table public.app_settings enable row level security;
create table public.business_settings (
  id uuid default gen_random_uuid() not null,
  business_name text,
  abn text,
  bsb text,
  account_number text,
  account_name text,
  payid text,
  default_notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  twilio_from_number text,
  twilio_webhook_url text,
  jarvis_notify_number text,
  jarvis_notify_enabled boolean default false not null,
  jarvis_timezone text default 'Australia/Sydney'::text not null,
  jarvis_quiet_start time without time zone default '20:00:00'::time without time zone not null,
  jarvis_quiet_end time without time zone default '07:30:00'::time without time zone not null,
  jarvis_daily_sms_cap integer default 10 not null,
  jarvis_from_number text,
  jarvis_call_enabled boolean default false not null,
  jarvis_call_cap integer default 3 not null,
  jarvis_call_voice text default 'Polly.Brian-Neural'::text not null,
  jarvis_owner_email text,
  sales_from_email text,
  sales_reply_to_email text,
  don_enabled boolean,
  don_active boolean,
  don_synced_at timestamp with time zone,
  jarvis_content_brief text,
  jarvis_model text,
  default_max_cpl_pct numeric(5,2) default 70,
  target_margin_pct numeric(5,2) default 30,
  dud_rate_pct numeric(5,2) default 12 not null,
  stripe_fee_pct numeric(5,2) default 1.75 not null,
  no_answer_email_enabled boolean default true not null,
  no_answer_email_days integer default 3 not null,
  no_answer_email_subject text default 'Sorry I missed you, {first_name}'::text not null,
  no_answer_email_body text default 'Hi {first_name},

I tried giving you a call about your enquiry with QuoteLeads but couldn''t catch you.

What''s a good time for a quick 10 minute chat? Just reply with a time that suits and I''ll ring you then.

{rep_name}
QuoteLeads'::text not null,
  no_answer_email_signoff text default ''::text not null,
  gst_rate_pct numeric(5,2) default 10 not null,
  price_includes_gst boolean default false not null,
  rep_commission_pct numeric(5,2) default 15 not null,
  commission_base text default 'ex'::text not null,
  stripe_fee_fixed numeric(10,2) default 0.30 not null,
  meta_dataset_id text
);

alter table public.business_settings enable row level security;
create table public.buyer_flags (
  id uuid default uuid_generate_v4() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  buyer_email text not null,
  flag_type text not null,
  reason text,
  dispute_rate_at_flag numeric(5,1)
);

alter table public.buyer_flags enable row level security;
create table public.campaign_spend_log (
  id uuid default gen_random_uuid() not null,
  campaign_id uuid,
  campaign_name text not null,
  meta_campaign_id text,
  period text not null,
  spend numeric default 0,
  leads integer default 0,
  clicks integer default 0,
  impressions integer default 0,
  source text default 'sync'::text not null,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table public.campaign_spend_log enable row level security;
create table public.client_action_log (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  action_type text default 'note'::text not null,
  notes text,
  logged_at timestamp with time zone default now() not null,
  actor_id uuid,
  actor_name text
);

alter table public.client_action_log enable row level security;
create table public.clients (
  id uuid default gen_random_uuid() not null,
  type text not null,
  company_name text not null,
  contact_name text,
  email text,
  phone text,
  niche text,
  lead_price numeric(10,2),
  leads_total integer default 0,
  leads_mtd integer default 0,
  pct_sold numeric(5,2),
  meta_cpl numeric(10,2),
  true_cpl numeric(10,2),
  balance numeric(10,2) default 0,
  ad_account_id text,
  monthly_budget numeric(10,2),
  management_fee numeric(10,2),
  cpl_today numeric(10,2),
  cpl_7d_avg numeric(10,2),
  spend_mtd numeric(10,2) default 0,
  stage text default 'lead'::text,
  status text,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  leads_delivered integer default 0 not null,
  total_leads_purchased integer default 0 not null,
  start_date date,
  last_payment_date date,
  next_payment_date date,
  has_reordered boolean default false not null,
  payments_made integer default 0,
  active_months text,
  leads_scrubbed integer default 0 not null,
  postcodes text[] default '{}'::text[],
  delivery_method text default 'email'::text,
  delivery_email text,
  delivery_phone text,
  custom_fields jsonb default '{}'::jsonb,
  last_lead_delivered_at timestamp with time zone,
  weekly_cap integer,
  monthly_cap integer,
  lead_template jsonb,
  has_quoteleads_platform_account boolean default false not null,
  client_webhook text,
  has_custom_integration boolean default false not null,
  total_leads_generated integer,
  meta_campaign_ids text[],
  meta_cap_paused boolean default false,
  meta_cap_paused_at timestamp with time zone,
  meta_cap_pause_reason text,
  cx_score integer,
  active_niches text[] default ARRAY['solar'::text],
  postcodes_radius integer default 50,
  delivery_email_cc text,
  from_name text default 'QuoteLeads'::text,
  hq_bearer_token text,
  onboarding_sub_stage text,
  active_status text,
  ql_hq_company_id text,
  ads_first_live_date date,
  retainer_payment_dates text default '{}'::text,
  webhook_auth_enabled boolean default false not null,
  webhook_secret text,
  webhook_auth_mode text default 'none'::text not null,
  webhook_auth_header text,
  target_leads_month integer,
  fulfilment_steps_done integer,
  fulfilment_steps_settled integer,
  fulfilment_steps_total integer,
  fulfilment_blocked_count integer,
  fulfilment_stage_at timestamp with time zone,
  fulfilment_next_step text,
  fulfilment_next_due timestamp with time zone,
  fulfilment_synced_at timestamp with time zone,
  managed_cpl_target numeric
);

alter table public.clients enable row level security;
create table public.contact_suppressions (
  id uuid default gen_random_uuid() not null,
  kind text not null,
  value text not null,
  reason text not null,
  source text,
  note text,
  created_at timestamp with time zone default now() not null
);

alter table public.contact_suppressions force row level security;
alter table public.contact_suppressions enable row level security;
create table public.customer_settings (
  id uuid default gen_random_uuid() not null,
  customer_email text not null,
  webhook_url text,
  webhook_last_fired timestamp with time zone,
  webhook_last_status integer,
  notification_lead_delivery text default 'both'::text not null,
  notification_order_status text default 'both'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table public.customer_settings enable row level security;
create table public.daily_notes (
  id uuid default gen_random_uuid() not null,
  date date default CURRENT_DATE not null,
  category text default 'general'::text not null,
  content text not null,
  created_at timestamp with time zone default now()
);

alter table public.daily_notes enable row level security;
create table public.daily_snapshots (
  id uuid default gen_random_uuid() not null,
  snapshot_date date not null,
  ppl_leads_today integer default 0,
  ppl_spend_today numeric default 0,
  ppl_cpl_today numeric default 0,
  ppl_leads_ytd integer default 0,
  ppl_spend_ytd numeric default 0,
  ppl_cpl_ytd numeric default 0,
  agency_spend_today numeric default 0,
  agency_spend_ytd numeric default 0,
  total_leads_ytd integer default 0,
  total_spend_ytd numeric default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table public.daily_snapshots enable row level security;
create table public.delivery_configs (
  ql_hq_company_id text not null,
  company_name text not null,
  email text,
  sms_number text,
  webhook_url text,
  updated_at timestamp with time zone default now() not null,
  webhook_auth_enabled boolean default false not null,
  webhook_secret text,
  webhook_auth_mode text default 'none'::text not null,
  webhook_auth_header text
);

alter table public.delivery_configs enable row level security;
create table public.dismissed_alerts (
  key text not null,
  dismissed_at timestamp with time zone default now() not null,
  dismissed_by uuid default auth.uid()
);

alter table public.dismissed_alerts enable row level security;
create table public.expenses (
  id uuid default gen_random_uuid() not null,
  date date not null,
  category text not null,
  description text,
  amount numeric(10,2) not null,
  type text default 'variable'::text,
  created_at timestamp with time zone default now()
);

alter table public.expenses enable row level security;
create table public.flagged_emails (
  id uuid default gen_random_uuid() not null,
  from_email text not null,
  from_name text,
  subject text,
  body_preview text,
  full_body text,
  ai_draft_reply text,
  client_id uuid,
  status text default 'pending'::text,
  created_at timestamp with time zone default now(),
  actioned_at timestamp with time zone
);

alter table public.flagged_emails enable row level security;
create table public.hiring_candidates (
  id uuid default gen_random_uuid() not null,
  name text not null,
  email text,
  phone text,
  role text,
  stage text default 'applied'::text not null,
  source text,
  expected_salary numeric,
  available_from date,
  resume_url text,
  rating integer,
  next_followup date,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone
);

alter table public.hiring_candidates enable row level security;
create table public.invoices (
  id uuid default gen_random_uuid() not null,
  invoice_number text,
  client_id uuid,
  client_name text,
  client_email text,
  offer_type text,
  vertical text,
  delivery_period_start date,
  delivery_period_end date,
  line_items jsonb,
  subtotal numeric,
  gst_type text default 'exclusive'::text,
  gst_amount numeric,
  total numeric,
  notes text,
  status text default 'draft'::text,
  invoice_date date,
  due_date date,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  owner_id uuid,
  payment_details text
);

alter table public.invoices enable row level security;
create table public.jarvis_events (
  id uuid default gen_random_uuid() not null,
  kind text not null,
  dedup_key text not null,
  tier text not null,
  subject text,
  payload jsonb default '{}'::jsonb not null,
  first_seen_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  notified_at timestamp with time zone,
  resolved_at timestamp with time zone,
  snoozed_until timestamp with time zone,
  phone_handled_at timestamp with time zone
);

alter table public.jarvis_events force row level security;
alter table public.jarvis_events enable row level security;
create table public.jarvis_jobs (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now() not null,
  title text not null,
  instruction text not null,
  repeat text default 'once'::text not null,
  next_run_at timestamp with time zone,
  active boolean default true not null,
  last_run_at timestamp with time zone,
  last_result text,
  runs integer default 0 not null,
  source text
);

alter table public.jarvis_jobs force row level security;
alter table public.jarvis_jobs enable row level security;
create table public.jarvis_memory (
  id uuid default gen_random_uuid() not null,
  content text not null,
  source text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table public.jarvis_memory force row level security;
alter table public.jarvis_memory enable row level security;
create table public.jarvis_messages (
  id uuid default gen_random_uuid() not null,
  direction text not null,
  body text not null,
  from_number text,
  to_number text,
  twilio_sid text,
  context jsonb default '{}'::jsonb not null,
  handled_at timestamp with time zone,
  error text,
  created_at timestamp with time zone default now() not null
);

alter table public.jarvis_messages force row level security;
alter table public.jarvis_messages enable row level security;
create table public.jarvis_notifications (
  id uuid default gen_random_uuid() not null,
  channel text default 'sms'::text not null,
  to_number text not null,
  tier text not null,
  body text not null,
  event_ids uuid[] default '{}'::uuid[] not null,
  twilio_sid text,
  status text default 'sent'::text not null,
  error text,
  created_at timestamp with time zone default now() not null,
  read_at timestamp with time zone
);

alter table public.jarvis_notifications force row level security;
alter table public.jarvis_notifications enable row level security;
create table public.jarvis_outbox (
  id uuid default gen_random_uuid() not null,
  campaign_id uuid not null,
  campaign text not null,
  lead_id uuid not null,
  lead_name text,
  channel text not null,
  recipient text,
  subject text,
  body text not null,
  status text default 'queued'::text not null,
  detail text,
  created_at timestamp with time zone default now() not null,
  attempted_at timestamp with time zone,
  sent_at timestamp with time zone
);

alter table public.jarvis_outbox force row level security;
alter table public.jarvis_outbox enable row level security;
create table public.jarvis_posts (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  caption text not null,
  original_caption text,
  platforms text[] default '{facebook,instagram}'::text[] not null,
  card jsonb,
  facts jsonb default '[]'::jsonb not null,
  image_url text,
  editor_score numeric(3,1),
  editor_notes text,
  status text default 'draft'::text not null,
  approved_at timestamp with time zone,
  posted_at timestamp with time zone,
  source text
);

alter table public.jarvis_posts force row level security;
alter table public.jarvis_posts enable row level security;
create table public.jarvis_threads (
  user_id uuid not null,
  messages jsonb default '[]'::jsonb not null,
  updated_at timestamp with time zone default now() not null
);

alter table public.jarvis_threads force row level security;
alter table public.jarvis_threads enable row level security;
create table public.jarvis_usage (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now() not null,
  channel text not null,
  user_id uuid,
  model text,
  outcome text,
  steps integer default 0 not null,
  input_tokens bigint default 0 not null,
  output_tokens bigint default 0 not null,
  cache_read_tokens bigint default 0 not null,
  cache_write_tokens bigint default 0 not null,
  web_searches integer default 0 not null,
  web_fetches integer default 0 not null,
  cost_usd numeric(12,6) default 0 not null
);

alter table public.jarvis_usage force row level security;
alter table public.jarvis_usage enable row level security;
create table public.lead_contact_log (
  id uuid default gen_random_uuid() not null,
  lead_id uuid not null,
  contact_type text default 'call'::text not null,
  outcome text,
  notes text,
  contacted_at timestamp with time zone default now() not null
);

alter table public.lead_contact_log enable row level security;
create table public.lead_delivery_log (
  id uuid default gen_random_uuid() not null,
  lead_id uuid,
  client_id uuid,
  method text not null,
  status text default 'pending'::text not null,
  destination text,
  response_code integer,
  response_body text,
  attempted_at timestamp with time zone default now() not null,
  delivered_at timestamp with time zone,
  message_preview text,
  created_at timestamp with time zone default now() not null
);

alter table public.lead_delivery_log enable row level security;
create table public.lead_disputes (
  id uuid default uuid_generate_v4() not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  lead_id uuid,
  buyer_email text not null,
  reason text not null,
  notes text,
  status text default 'open'::text not null,
  resolution_note text,
  resolution_type text,
  replacement_lead_id uuid,
  resolved_at timestamp with time zone
);

alter table public.lead_disputes enable row level security;
create table public.lead_pricing_areas (
  id uuid default gen_random_uuid() not null,
  label text not null,
  cpl numeric(10,2),
  geo_json text,
  created_at timestamp with time zone default now(),
  internal_cpl numeric(10,2),
  notes text
);

alter table public.lead_pricing_areas enable row level security;
create table public.lead_sms_log (
  id uuid default gen_random_uuid() not null,
  lead_id uuid,
  to_number text not null,
  message text not null,
  sent_by text not null,
  twilio_sid text,
  status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null,
  direction text default 'outbound'::text not null
);

alter table public.lead_sms_log enable row level security;
create table public.leads (
  id uuid default gen_random_uuid() not null,
  name text not null,
  company text,
  email text,
  phone text,
  stage text default 'new_lead'::text not null,
  value numeric(10,2),
  source text,
  notes text,
  last_contact timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  created_by uuid,
  lead_type text default 'ppl'::text,
  contactable boolean,
  niche text default 'solar'::text not null,
  subtype text,
  suburb text,
  state text,
  custom_data jsonb default '{}'::jsonb not null,
  delivery_attempts integer default 0 not null,
  last_delivery_at timestamp with time zone,
  delivery_error text,
  assigned_client_id uuid,
  assigned_at timestamp with time zone,
  is_homeowner boolean,
  avg_quarterly_bill numeric,
  interested_in text,
  purchase_timeline text,
  status text default 'pending'::text not null,
  contact_count integer default 0 not null,
  next_followup date,
  owner_id uuid,
  sms_opted_out boolean default false not null,
  sms_opted_out_at timestamp with time zone,
  info_sent_at timestamp with time zone,
  info_sent_by uuid,
  followup_sent_at timestamp with time zone,
  followup_sent_by uuid,
  hq_company_id uuid,
  hq_account_created_at timestamp with time zone,
  hq_va_user_id uuid,
  hq_va_assigned_at timestamp with time zone,
  stage_changed_at timestamp with time zone,
  no_answer_email_sent_at timestamp with time zone,
  info_5k_sent_at timestamp with time zone,
  info_5k_sent_by uuid
);

create table public.leads_daily (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  date date not null,
  leads_generated integer default 0,
  leads_sold integer default 0,
  pct_sold numeric(5,2),
  meta_cpl numeric(10,2),
  true_cpl numeric(10,2),
  leads_count integer default 0,
  spend numeric(10,2) default 0,
  client_name text,
  account_type text,
  running_total integer
);

alter table public.leads_daily enable row level security;
alter table public.leads enable row level security;
create table public.managed_alerts (
  dedup_key text not null,
  managed_campaign_id uuid,
  kind text not null,
  tier text not null,
  subject text,
  payload jsonb default '{}'::jsonb not null,
  active boolean default true not null,
  updated_at timestamp with time zone default now() not null
);

alter table public.managed_alerts enable row level security;
create table public.managed_campaigns (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  hq_company_id text not null,
  meta_campaign_id text not null,
  ad_account_id text not null,
  name text not null,
  status text default 'PAUSED'::text not null,
  notes text,
  built_at timestamp with time zone default now() not null,
  launched_at timestamp with time zone,
  launched_by text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  effective_status text,
  daily_budget numeric,
  spend_today numeric,
  spend_7d numeric,
  leads_7d integer,
  cpl_7d numeric,
  issues jsonb default '[]'::jsonb not null,
  checked_at timestamp with time zone
);

alter table public.managed_campaigns enable row level security;
create table public.managed_launch_log (
  id uuid default gen_random_uuid() not null,
  managed_campaign_id uuid,
  client_id uuid,
  action text not null,
  by_name text,
  daily_budget numeric,
  preflight jsonb,
  created_at timestamp with time zone default now() not null
);

alter table public.managed_launch_log enable row level security;
create table public.managed_order_log (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  description text,
  amount numeric,
  order_date date,
  created_at timestamp with time zone default now()
);

alter table public.managed_order_log enable row level security;
create table public.meta_ad_accounts (
  id uuid default gen_random_uuid() not null,
  account_id text not null,
  label text not null,
  created_at timestamp with time zone default now()
);

alter table public.meta_ad_accounts enable row level security;
create table public.meta_api_log (
  id uuid default gen_random_uuid() not null,
  action text not null,
  campaign_ids text[] default '{}'::text[],
  results jsonb default '[]'::jsonb,
  triggered_by text,
  created_at timestamp with time zone default now()
);

alter table public.meta_api_log enable row level security;
create table public.meta_campaigns (
  id uuid default gen_random_uuid() not null,
  name text not null,
  meta_campaign_id text not null,
  ad_account_id text default ''::text not null,
  status text default 'ACTIVE'::text not null,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  spend_mtd numeric default 0,
  impressions_mtd integer default 0,
  clicks_mtd integer default 0,
  leads_mtd integer default 0,
  cpl_mtd numeric default 0,
  last_synced_at timestamp with time zone,
  area_ids uuid[] default '{}'::uuid[],
  cost_paused boolean default false not null,
  cost_paused_at timestamp with time zone,
  cost_pause_reason text,
  spend_3d numeric(10,2),
  leads_3d integer,
  cpl_3d numeric(10,2),
  cost_checked_at timestamp with time zone
);

alter table public.meta_campaigns enable row level security;
create table public.meta_capi_events (
  lead_id uuid not null,
  dataset_id text not null,
  event_name text default 'Purchase'::text not null,
  value numeric,
  matched_by text[] default '{}'::text[] not null,
  sent_at timestamp with time zone,
  error text,
  attempts integer default 0 not null,
  created_at timestamp with time zone default now() not null
);

alter table public.meta_capi_events enable row level security;
create table public.monthly_goals (
  id uuid default gen_random_uuid() not null,
  month text not null,
  revenue_goal numeric default 0,
  margin_goal numeric default 0,
  notes text default ''::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

alter table public.monthly_goals enable row level security;
create table public.outreach_events (
  id uuid default gen_random_uuid() not null,
  received_at timestamp with time zone default now() not null,
  event_type text not null,
  campaign_id text,
  lead_email text,
  prospect_id uuid,
  step integer,
  email_id text,
  subject text,
  body text,
  handled text,
  payload jsonb default '{}'::jsonb not null
);

alter table public.outreach_events force row level security;
alter table public.outreach_events enable row level security;
create table public.outreach_niches (
  key text not null,
  label text not null,
  enabled boolean default false not null,
  daily_target integer default 25 not null,
  regions text[] default '{}'::text[] not null,
  search_terms text[] default '{}'::text[] not null,
  offer text,
  notes text,
  sort_order integer default 0 not null,
  updated_at timestamp with time zone default now() not null,
  sequence jsonb default '[]'::jsonb not null,
  sequence_approved_at timestamp with time zone,
  instantly_campaign_id text,
  campaign_synced_at timestamp with time zone,
  campaign_state text
);

alter table public.outreach_niches force row level security;
alter table public.outreach_niches enable row level security;
create table public.outreach_queries (
  niche_key text not null,
  query text not null,
  runs integer default 0 not null,
  results integer default 0 not null,
  added integer default 0 not null,
  last_run_at timestamp with time zone
);

alter table public.outreach_queries force row level security;
alter table public.outreach_queries enable row level security;
create table public.outreach_runs (
  id uuid default gen_random_uuid() not null,
  trigger text default 'cron'::text not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  searches integer default 0 not null,
  found integer default 0 not null,
  blocked integer default 0 not null,
  emails integer default 0 not null,
  no_email integer default 0 not null,
  verified integer default 0 not null,
  invalid integer default 0 not null,
  errors text[] default '{}'::text[] not null,
  note text,
  qualified integer default 0 not null,
  not_fit integer default 0 not null,
  ai_cost_usd numeric(10,4) default 0 not null
);

alter table public.outreach_runs force row level security;
alter table public.outreach_runs enable row level security;
create table public.outreach_sent (
  channel text not null,
  recipient text not null,
  msg_hash text not null,
  lead_id uuid,
  claimed_at timestamp with time zone default now() not null
);

alter table public.outreach_sent force row level security;
alter table public.outreach_sent enable row level security;
create table public.outreach_settings (
  id integer default 1 not null,
  sender_name text,
  business_name text default 'QuoteLeads'::text not null,
  postal_address text,
  sending_accounts text[] default '{}'::text[] not null,
  send_from text default '08:30'::text not null,
  send_to text default '16:30'::text not null,
  timezone text default 'Australia/Brisbane'::text not null,
  daily_limit integer default 30 not null,
  webhook_id text,
  webhook_secret text,
  updated_at timestamp with time zone default now() not null
);

alter table public.outreach_settings force row level security;
alter table public.outreach_settings enable row level security;
create table public.pay_rates (
  id uuid default gen_random_uuid() not null,
  role_type text not null,
  rate_type text not null,
  amount numeric not null,
  created_at timestamp with time zone default now() not null
);

alter table public.pay_rates enable row level security;
create table public.pending_orders (
  id uuid default gen_random_uuid() not null,
  stripe_session_id text not null,
  order_data jsonb not null,
  status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null
);

alter table public.pending_orders enable row level security;
create table public.pilot_leads (
  id uuid default uuid_generate_v4() not null,
  created_at timestamp with time zone default now() not null,
  order_id uuid,
  buyer_email text not null,
  first_name text,
  last_name text,
  phone text,
  email text,
  suburb text,
  postcode text,
  state text,
  lead_type text,
  lead_subtype text,
  notes text,
  status text default 'delivered'::text not null,
  outcome text,
  outcome_updated_at timestamp with time zone,
  ad_source text,
  submission_timestamp timestamp with time zone,
  survey_responses jsonb default '{}'::jsonb,
  consent_record text,
  phone_verification_status text
);

alter table public.pilot_leads enable row level security;
create table public.pilot_orders (
  id uuid default uuid_generate_v4() not null,
  created_at timestamp with time zone default now() not null,
  email text not null,
  delivery_email text,
  delivery_phone text,
  lead_count integer default 10 not null,
  payment_status text default 'pending'::text not null,
  amount_paid numeric(10,2),
  stripe_session_id text,
  discount_code text,
  discount_amount numeric(10,2) default 0,
  intake_first_name text,
  intake_last_name text,
  intake_company text,
  intake_phone text,
  lead_type text,
  lead_subtype jsonb,
  service_postcode text,
  service_radius text,
  status text default 'configuring'::text not null,
  leads_delivered integer default 0 not null,
  estimated_completion date,
  client_id uuid
);

alter table public.pilot_orders enable row level security;
create table public.ppl_campaign_action_log (
  id uuid default gen_random_uuid() not null,
  campaign_id uuid not null,
  action_type text default 'note'::text not null,
  details text,
  logged_at timestamp with time zone default now() not null
);

alter table public.ppl_campaign_action_log enable row level security;
create table public.ppl_campaigns (
  id uuid default gen_random_uuid() not null,
  name text not null,
  status text default 'active'::text not null,
  niche text,
  area text,
  meta_campaign_id uuid,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

alter table public.ppl_campaigns enable row level security;
create table public.ppl_lead_areas (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  label text not null,
  volume integer default 0 not null,
  geo_json text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  meta_campaign_ids text[] default '{}'::text[],
  client_ids uuid[] default '{}'::uuid[]
);

alter table public.ppl_lead_areas enable row level security;
create table public.ppl_leads (
  id uuid default gen_random_uuid() not null,
  name text not null,
  email text,
  phone text,
  postcode text not null,
  address text,
  suburb text,
  state text,
  property_type text,
  roof_type text,
  monthly_bill numeric,
  system_size text,
  interested_in text,
  assigned_client_id uuid,
  assigned_at timestamp with time zone,
  status text default 'pending'::text not null,
  delivery_method text,
  delivered_at timestamp with time zone,
  delivery_error text,
  source text default 'make'::text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  is_homeowner text,
  avg_quarterly_bill text,
  purchase_timeline text,
  phone_verified boolean default false,
  email_verified boolean default false,
  custom_fields text default '{}'::jsonb,
  delivery_audit_log text,
  lead_type text default 'solar'::text not null
);

alter table public.ppl_leads enable row level security;
create table public.ppl_order_log (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  leads_qty integer default 0 not null,
  lead_price numeric default 0 not null,
  notes text,
  order_date date default CURRENT_DATE not null,
  created_at timestamp with time zone default now() not null,
  status text default 'in_progress'::text not null,
  leads_generated integer,
  meta_cpl numeric,
  purchase_date date,
  sla_due_date date,
  max_cpl numeric(10,2),
  cpl_breached_at timestamp with time zone,
  rep_commission_pct numeric(5,2),
  commission_base text
);

alter table public.ppl_order_log enable row level security;
create table public.prospects (
  id uuid default gen_random_uuid() not null,
  niche_key text not null,
  business_name text not null,
  abn text,
  website text,
  domain text,
  email text,
  email_source_url text,
  contact_name text,
  contact_role text,
  phone text,
  address text,
  suburb text,
  state text,
  postcode text,
  google_place_id text,
  source text not null,
  source_ref text,
  found_at timestamp with time zone default now() not null,
  status text default 'new'::text not null,
  status_reason text,
  email_verdict text,
  verified_at timestamp with time zone,
  fit_score numeric(4,1),
  fit_notes text,
  opener text,
  contacted_at timestamp with time zone,
  last_event_at timestamp with time zone,
  lead_id uuid,
  meta jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  queued_at timestamp with time zone,
  instantly_pushed_at timestamp with time zone
);

alter table public.prospects force row level security;
alter table public.prospects enable row level security;
create table public.revenue (
  id uuid default gen_random_uuid() not null,
  date date not null,
  client_id uuid,
  type text not null,
  description text,
  amount numeric(10,2) not null,
  invoice_id text,
  created_at timestamp with time zone default now()
);

alter table public.revenue enable row level security;
create table public.sales_email_log (
  id uuid default gen_random_uuid() not null,
  lead_id uuid,
  kind text not null,
  to_email text not null,
  reply_to text,
  subject text not null,
  body text not null,
  sent_by uuid,
  provider_id text,
  sent_at timestamp with time zone default now() not null,
  via text
);

alter table public.sales_email_log enable row level security;
create table public.sales_email_templates (
  kind text not null,
  subject text default ''::text not null,
  body text default ''::text not null,
  updated_at timestamp with time zone,
  updated_by uuid
);

alter table public.sales_email_templates enable row level security;
create table public.sales_rep_config (
  id integer default 1 not null,
  auto_assign_enabled boolean default false not null,
  updated_at timestamp with time zone default now() not null,
  auto_assign_rep_id uuid,
  auto_assign_mode text default 'least_busy'::text not null,
  round_robin_pool text[] default '{}'::text[] not null,
  round_robin_cursor bigint default 0 not null,
  house_email text default 'contact@quoteleads.com.au'::text not null
);

alter table public.sales_rep_config enable row level security;
create table public.sales_reps (
  user_id uuid not null,
  email text,
  name text,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null,
  reply_to_email text
);

alter table public.sales_reps enable row level security;
create table public.sales_sms_log (
  id uuid default gen_random_uuid() not null,
  lead_id uuid,
  to_number text,
  from_number text,
  message text,
  direction text default 'outbound'::text not null,
  status text,
  twilio_sid text,
  error text,
  created_at timestamp with time zone default now() not null,
  sent_by text
);

alter table public.sales_sms_log enable row level security;
create table public.sms_opt_outs (
  phone text not null,
  opted_out boolean default true not null,
  source text,
  updated_at timestamp with time zone default now() not null
);

alter table public.sms_opt_outs force row level security;
alter table public.sms_opt_outs enable row level security;
create table public.subscriptions (
  id uuid default gen_random_uuid() not null,
  name text not null,
  monthly_cost numeric(10,2) not null,
  billing_date integer,
  active boolean default true,
  notes text,
  created_at timestamp with time zone default now()
);

alter table public.subscriptions enable row level security;
create table public.tasks (
  id uuid default gen_random_uuid() not null,
  title text not null,
  assigned_to text default 'human'::text,
  priority text default 'normal'::text,
  done boolean default false,
  notes text,
  due_date date,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  linked_ref text,
  linked_name text
);

alter table public.tasks enable row level security;
create table public.webhook_delivery_log (
  id uuid default gen_random_uuid() not null,
  customer_email text not null,
  lead_id uuid,
  order_id uuid,
  webhook_url text not null,
  status_code integer,
  attempt integer default 1 not null,
  response_body text,
  created_at timestamp with time zone default now() not null
);

alter table public.webhook_delivery_log enable row level security;

-- ===== Keys, unique and check constraints =====
alter table public.ad_spend_daily add constraint ad_spend_daily_account_type_check CHECK ((account_type = ANY (ARRAY['solar_ppl'::text, 'agency'::text, 'managed_client'::text])));
alter table public.ad_spend_daily add constraint ad_spend_daily_date_account_type_account_id_key UNIQUE (date, account_type, account_id);
alter table public.ad_spend_daily add constraint ad_spend_daily_date_account_type_key UNIQUE (date, account_type);
alter table public.ad_spend_daily add constraint ad_spend_daily_pkey PRIMARY KEY (id);
alter table public.ad_spend_daily add constraint valid_account_type CHECK ((account_type = ANY (ARRAY['solar_ppl'::text, 'agency'::text])));
alter table public.agent_files add constraint agent_files_agent_filename_key UNIQUE (agent, filename);
alter table public.agent_files add constraint agent_files_pkey PRIMARY KEY (id);
alter table public.app_settings add constraint app_settings_pkey PRIMARY KEY (key);
alter table public.business_settings add constraint business_settings_commission_base_check CHECK ((commission_base = ANY (ARRAY['ex'::text, 'inc'::text])));
alter table public.business_settings add constraint business_settings_jarvis_call_cap_check CHECK (((jarvis_call_cap >= 0) AND (jarvis_call_cap <= 20)));
alter table public.business_settings add constraint business_settings_jarvis_daily_sms_cap_check CHECK (((jarvis_daily_sms_cap >= 0) AND (jarvis_daily_sms_cap <= 100)));
alter table public.business_settings add constraint business_settings_jarvis_model_check CHECK (((jarvis_model IS NULL) OR (jarvis_model = ANY (ARRAY['claude-opus-5-5'::text, 'claude-sonnet-5-5'::text]))));
alter table public.business_settings add constraint business_settings_meta_dataset_id_digits CHECK (((meta_dataset_id IS NULL) OR (meta_dataset_id ~ '^[0-9]{6,20}$'::text)));
alter table public.business_settings add constraint business_settings_pkey PRIMARY KEY (id);
alter table public.buyer_flags add constraint buyer_flags_buyer_email_key UNIQUE (buyer_email);
alter table public.buyer_flags add constraint buyer_flags_flag_type_check CHECK ((flag_type = ANY (ARRAY['warning'::text, 'delivery_paused'::text])));
alter table public.buyer_flags add constraint buyer_flags_pkey PRIMARY KEY (id);
alter table public.campaign_spend_log add constraint campaign_spend_log_period_check CHECK ((period ~ '^\d{4}-(0[1-9]|1[0-2])$'::text));
alter table public.campaign_spend_log add constraint campaign_spend_log_pkey PRIMARY KEY (id);
alter table public.client_action_log add constraint client_action_log_pkey PRIMARY KEY (id);
alter table public.clients add constraint clients_pkey PRIMARY KEY (id);
alter table public.clients add constraint clients_type_check CHECK ((type = ANY (ARRAY['managed'::text, 'ppl'::text, 'tle'::text])));
alter table public.clients add constraint clients_webhook_auth_mode_chk CHECK ((webhook_auth_mode = ANY (ARRAY['none'::text, 'header'::text, 'signature'::text]))) NOT VALID;
alter table public.contact_suppressions add constraint contact_suppressions_kind_check CHECK ((kind = ANY (ARRAY['email'::text, 'phone'::text, 'domain'::text])));
alter table public.contact_suppressions add constraint contact_suppressions_kind_value_key UNIQUE (kind, value);
alter table public.contact_suppressions add constraint contact_suppressions_pkey PRIMARY KEY (id);
alter table public.contact_suppressions add constraint contact_suppressions_reason_check CHECK ((reason = ANY (ARRAY['unsubscribed'::text, 'bounced'::text, 'complained'::text, 'not_interested'::text, 'do_not_contact'::text, 'manual'::text])));
alter table public.customer_settings add constraint customer_settings_customer_email_key UNIQUE (customer_email);
alter table public.customer_settings add constraint customer_settings_notification_lead_delivery_check CHECK ((notification_lead_delivery = ANY (ARRAY['sms'::text, 'email'::text, 'both'::text])));
alter table public.customer_settings add constraint customer_settings_notification_order_status_check CHECK ((notification_order_status = ANY (ARRAY['sms'::text, 'email'::text, 'both'::text])));
alter table public.customer_settings add constraint customer_settings_pkey PRIMARY KEY (id);
alter table public.daily_notes add constraint daily_notes_pkey PRIMARY KEY (id);
alter table public.daily_snapshots add constraint daily_snapshots_pkey PRIMARY KEY (id);
alter table public.daily_snapshots add constraint daily_snapshots_snapshot_date_key UNIQUE (snapshot_date);
alter table public.delivery_configs add constraint delivery_configs_pkey PRIMARY KEY (ql_hq_company_id);
alter table public.delivery_configs add constraint delivery_configs_webhook_auth_mode_chk CHECK ((webhook_auth_mode = ANY (ARRAY['none'::text, 'header'::text, 'signature'::text]))) NOT VALID;
alter table public.dismissed_alerts add constraint dismissed_alerts_pkey PRIMARY KEY (key);
alter table public.expenses add constraint expenses_pkey PRIMARY KEY (id);
alter table public.expenses add constraint expenses_type_check CHECK ((type = ANY (ARRAY['fixed'::text, 'variable'::text])));
alter table public.flagged_emails add constraint flagged_emails_pkey PRIMARY KEY (id);
alter table public.flagged_emails add constraint flagged_emails_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'discarded'::text, 'sent'::text])));
alter table public.hiring_candidates add constraint hiring_candidates_pkey PRIMARY KEY (id);
alter table public.hiring_candidates add constraint hiring_candidates_rating_check CHECK (((rating IS NULL) OR ((rating >= 0) AND (rating <= 10))));
alter table public.hiring_candidates add constraint hiring_candidates_stage_check CHECK ((stage = ANY (ARRAY['applied'::text, 'screening'::text, 'interview'::text, 'offer'::text, 'hired'::text, 'rejected'::text])));
alter table public.invoices add constraint invoices_invoice_number_key UNIQUE (invoice_number);
alter table public.invoices add constraint invoices_pkey PRIMARY KEY (id);
alter table public.jarvis_events add constraint jarvis_events_dedup_key_key UNIQUE (dedup_key);
alter table public.jarvis_events add constraint jarvis_events_pkey PRIMARY KEY (id);
alter table public.jarvis_events add constraint jarvis_events_tier_check CHECK ((tier = ANY (ARRAY['urgent'::text, 'notable'::text, 'digest'::text])));
alter table public.jarvis_jobs add constraint jarvis_jobs_instruction_check CHECK (((length(instruction) >= 1) AND (length(instruction) <= 2000)));
alter table public.jarvis_jobs add constraint jarvis_jobs_pkey PRIMARY KEY (id);
alter table public.jarvis_jobs add constraint jarvis_jobs_repeat_check CHECK ((repeat = ANY (ARRAY['once'::text, 'daily'::text, 'weekdays'::text, 'weekly'::text, 'monthly'::text])));
alter table public.jarvis_jobs add constraint jarvis_jobs_title_check CHECK (((length(title) >= 1) AND (length(title) <= 120)));
alter table public.jarvis_memory add constraint jarvis_memory_content_check CHECK (((length(content) >= 1) AND (length(content) <= 1000)));
alter table public.jarvis_memory add constraint jarvis_memory_pkey PRIMARY KEY (id);
alter table public.jarvis_messages add constraint jarvis_messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])));
alter table public.jarvis_messages add constraint jarvis_messages_pkey PRIMARY KEY (id);
alter table public.jarvis_notifications add constraint jarvis_notifications_pkey PRIMARY KEY (id);
alter table public.jarvis_outbox add constraint jarvis_outbox_campaign_id_lead_id_channel_key UNIQUE (campaign_id, lead_id, channel);
alter table public.jarvis_outbox add constraint jarvis_outbox_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text])));
alter table public.jarvis_outbox add constraint jarvis_outbox_pkey PRIMARY KEY (id);
alter table public.jarvis_outbox add constraint jarvis_outbox_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'skipped'::text, 'failed'::text])));
alter table public.jarvis_posts add constraint jarvis_posts_caption_check CHECK (((length(caption) >= 1) AND (length(caption) <= 2200)));
alter table public.jarvis_posts add constraint jarvis_posts_pkey PRIMARY KEY (id);
alter table public.jarvis_posts add constraint jarvis_posts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'posted'::text, 'rejected'::text])));
alter table public.jarvis_threads add constraint jarvis_threads_pkey PRIMARY KEY (user_id);
alter table public.jarvis_usage add constraint jarvis_usage_pkey PRIMARY KEY (id);
alter table public.lead_contact_log add constraint lead_contact_log_pkey PRIMARY KEY (id);
alter table public.lead_delivery_log add constraint lead_delivery_log_pkey PRIMARY KEY (id);
alter table public.lead_disputes add constraint lead_disputes_pkey PRIMARY KEY (id);
alter table public.lead_disputes add constraint lead_disputes_reason_check CHECK ((reason = ANY (ARRAY['unreachable'::text, 'duplicate'::text, 'out_of_area'::text, 'wrong_type'::text, 'no_intent'::text, 'other'::text])));
alter table public.lead_disputes add constraint lead_disputes_resolution_type_check CHECK ((resolution_type = ANY (ARRAY['auto'::text, 'manual'::text])));
alter table public.lead_disputes add constraint lead_disputes_status_check CHECK ((status = ANY (ARRAY['open'::text, 'under_review'::text, 'resolved'::text, 'rejected'::text])));
alter table public.lead_pricing_areas add constraint lead_pricing_areas_pkey PRIMARY KEY (id);
alter table public.lead_sms_log add constraint lead_sms_log_pkey PRIMARY KEY (id);
alter table public.leads add constraint leads_lead_type_check CHECK ((lead_type = ANY (ARRAY['ppl'::text, 'managed'::text])));
alter table public.leads add constraint leads_pkey PRIMARY KEY (id);
alter table public.leads add constraint leads_stage_check CHECK ((stage = ANY (ARRAY['new_lead'::text, 'no_answer'::text, 'call_back'::text, 'proposal'::text, 'closed_won'::text, 'closed_lost'::text])));
alter table public.leads add constraint leads_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'assigned'::text, 'delivered'::text, 'failed'::text, 'scrubbed'::text])));
alter table public.leads_daily add constraint leads_daily_account_type_check CHECK ((account_type = ANY (ARRAY['solar_ppl'::text, 'agency'::text, 'managed_client'::text])));
alter table public.leads_daily add constraint leads_daily_client_id_date_key UNIQUE (client_id, date);
alter table public.leads_daily add constraint leads_daily_pkey PRIMARY KEY (id);
alter table public.managed_alerts add constraint managed_alerts_pkey PRIMARY KEY (dedup_key);
alter table public.managed_alerts add constraint managed_alerts_tier_check CHECK ((tier = ANY (ARRAY['urgent'::text, 'notable'::text])));
alter table public.managed_campaigns add constraint managed_campaigns_meta_campaign_id_key UNIQUE (meta_campaign_id);
alter table public.managed_campaigns add constraint managed_campaigns_pkey PRIMARY KEY (id);
alter table public.managed_campaigns add constraint managed_campaigns_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'PAUSED'::text])));
alter table public.managed_launch_log add constraint managed_launch_log_action_check CHECK ((action = ANY (ARRAY['launch'::text, 'pause'::text])));
alter table public.managed_launch_log add constraint managed_launch_log_pkey PRIMARY KEY (id);
alter table public.managed_order_log add constraint managed_order_log_pkey PRIMARY KEY (id);
alter table public.meta_ad_accounts add constraint meta_ad_accounts_account_id_key UNIQUE (account_id);
alter table public.meta_ad_accounts add constraint meta_ad_accounts_pkey PRIMARY KEY (id);
alter table public.meta_api_log add constraint meta_api_log_pkey PRIMARY KEY (id);
alter table public.meta_campaigns add constraint meta_campaigns_meta_campaign_id_key UNIQUE (meta_campaign_id);
alter table public.meta_campaigns add constraint meta_campaigns_pkey PRIMARY KEY (id);
alter table public.meta_campaigns add constraint meta_campaigns_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'PAUSED'::text])));
alter table public.meta_capi_events add constraint meta_capi_events_pkey PRIMARY KEY (lead_id, event_name);
alter table public.monthly_goals add constraint monthly_goals_month_key UNIQUE (month);
alter table public.monthly_goals add constraint monthly_goals_pkey PRIMARY KEY (id);
alter table public.outreach_events add constraint outreach_events_pkey PRIMARY KEY (id);
alter table public.outreach_niches add constraint outreach_niches_daily_target_check CHECK (((daily_target >= 0) AND (daily_target <= 300)));
alter table public.outreach_niches add constraint outreach_niches_pkey PRIMARY KEY (key);
alter table public.outreach_queries add constraint outreach_queries_pkey PRIMARY KEY (niche_key, query);
alter table public.outreach_runs add constraint outreach_runs_pkey PRIMARY KEY (id);
alter table public.outreach_sent add constraint outreach_sent_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text])));
alter table public.outreach_sent add constraint outreach_sent_pkey PRIMARY KEY (channel, recipient, msg_hash);
alter table public.outreach_settings add constraint outreach_settings_daily_limit_check CHECK (((daily_limit >= 1) AND (daily_limit <= 500)));
alter table public.outreach_settings add constraint outreach_settings_id_check CHECK ((id = 1));
alter table public.outreach_settings add constraint outreach_settings_pkey PRIMARY KEY (id);
alter table public.outreach_settings add constraint outreach_settings_send_from_check CHECK ((send_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text));
alter table public.outreach_settings add constraint outreach_settings_send_to_check CHECK ((send_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text));
alter table public.pay_rates add constraint pay_rates_pkey PRIMARY KEY (id);
alter table public.pay_rates add constraint pay_rates_rate_type_check CHECK ((rate_type = ANY (ARRAY['fixed'::text, 'commission'::text])));
alter table public.pending_orders add constraint pending_orders_pkey PRIMARY KEY (id);
alter table public.pending_orders add constraint pending_orders_stripe_session_id_key UNIQUE (stripe_session_id);
alter table public.pilot_leads add constraint pilot_leads_outcome_check CHECK ((outcome = ANY (ARRAY['won'::text, 'booked'::text, 'no_answer'::text, 'not_interested'::text])));
alter table public.pilot_leads add constraint pilot_leads_phone_verification_status_check CHECK ((phone_verification_status = ANY (ARRAY['verified'::text, 'unverified'::text, 'failed'::text])));
alter table public.pilot_leads add constraint pilot_leads_pkey PRIMARY KEY (id);
alter table public.pilot_leads add constraint pilot_leads_status_check CHECK ((status = ANY (ARRAY['delivered'::text, 'disputed'::text, 'replaced'::text, 'invalid'::text])));
alter table public.pilot_orders add constraint pilot_orders_payment_status_check CHECK ((payment_status = ANY (ARRAY['pending'::text, 'paid'::text, 'refunded'::text])));
alter table public.pilot_orders add constraint pilot_orders_pkey PRIMARY KEY (id);
alter table public.pilot_orders add constraint pilot_orders_status_check CHECK ((status = ANY (ARRAY['configuring'::text, 'active'::text, 'delivering'::text, 'complete'::text])));
alter table public.pilot_orders add constraint pilot_orders_stripe_session_id_key UNIQUE (stripe_session_id);
alter table public.ppl_campaign_action_log add constraint ppl_campaign_action_log_pkey PRIMARY KEY (id);
alter table public.ppl_campaigns add constraint ppl_campaigns_pkey PRIMARY KEY (id);
alter table public.ppl_lead_areas add constraint ppl_lead_areas_pkey PRIMARY KEY (id);
alter table public.ppl_leads add constraint solar_leads_pkey PRIMARY KEY (id);
alter table public.ppl_leads add constraint solar_leads_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'assigned'::text, 'delivered'::text, 'failed'::text, 'scrubbed'::text])));
alter table public.ppl_order_log add constraint ppl_order_log_commission_base_check CHECK ((commission_base = ANY (ARRAY['ex'::text, 'inc'::text])));
alter table public.ppl_order_log add constraint ppl_order_log_pkey PRIMARY KEY (id);
alter table public.prospects add constraint prospects_email_verdict_check CHECK ((email_verdict = ANY (ARRAY['valid'::text, 'risky'::text, 'invalid'::text, 'unknown'::text])));
alter table public.prospects add constraint prospects_pkey PRIMARY KEY (id);
alter table public.prospects add constraint prospects_status_check CHECK ((status = ANY (ARRAY['new'::text, 'enriched'::text, 'verified'::text, 'qualified'::text, 'rejected'::text, 'blocked'::text, 'queued'::text, 'contacted'::text, 'replied'::text, 'interested'::text, 'not_interested'::text, 'unsubscribed'::text, 'bounced'::text, 'converted'::text])));
alter table public.revenue add constraint revenue_date_type_key UNIQUE (date, type);
alter table public.revenue add constraint revenue_pkey PRIMARY KEY (id);
alter table public.revenue add constraint revenue_type_check CHECK ((type = ANY (ARRAY['ppl'::text, 'management_fee'::text, 'other'::text])));
alter table public.sales_email_log add constraint sales_email_log_kind_check CHECK ((kind = ANY (ARRAY['info'::text, 'info_5k'::text, 'followup'::text, 'campaign'::text, 'no_answer'::text])));
alter table public.sales_email_log add constraint sales_email_log_pkey PRIMARY KEY (id);
alter table public.sales_email_templates add constraint sales_email_templates_kind_check CHECK ((kind = ANY (ARRAY['info'::text, 'info_5k'::text, 'followup'::text])));
alter table public.sales_email_templates add constraint sales_email_templates_pkey PRIMARY KEY (kind);
alter table public.sales_rep_config add constraint sales_rep_config_mode_chk CHECK ((auto_assign_mode = ANY (ARRAY['least_busy'::text, 'fixed'::text, 'round_robin'::text])));
alter table public.sales_rep_config add constraint sales_rep_config_pkey PRIMARY KEY (id);
alter table public.sales_rep_config add constraint sales_rep_config_singleton CHECK ((id = 1));
alter table public.sales_reps add constraint sales_reps_pkey PRIMARY KEY (user_id);
alter table public.sales_sms_log add constraint sales_sms_log_pkey PRIMARY KEY (id);
alter table public.sms_opt_outs add constraint sms_opt_outs_pkey PRIMARY KEY (phone);
alter table public.subscriptions add constraint subscriptions_pkey PRIMARY KEY (id);
alter table public.tasks add constraint tasks_pkey PRIMARY KEY (id);
alter table public.tasks add constraint tasks_priority_check CHECK ((priority = ANY (ARRAY['urgent'::text, 'normal'::text, 'low'::text, 'ai'::text])));
alter table public.webhook_delivery_log add constraint webhook_delivery_log_pkey PRIMARY KEY (id);

-- ===== Functions =====
CREATE OR REPLACE FUNCTION public.add_lead(p_name text, p_company text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_stage text DEFAULT 'new'::text, p_lead_type text DEFAULT NULL::text, p_value numeric DEFAULT NULL::numeric, p_source text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_lead record;
  v_id   uuid;
BEGIN
  IF trim(p_name) = '' OR p_name IS NULL THEN
    RAISE EXCEPTION 'name is required';
  END IF;

  SELECT * INTO v_lead
  FROM public.leads
  WHERE name = trim(p_name)
    AND (
      (p_email IS NOT NULL AND email = trim(p_email))
      OR
      (p_phone IS NOT NULL AND phone = trim(p_phone))
    )
  LIMIT 1;

  IF v_lead IS NULL THEN
    INSERT INTO public.leads (name, company, email, phone, stage, lead_type, value, source, notes, created_at, updated_at)
    VALUES (
      trim(p_name),
      NULLIF(trim(COALESCE(p_company, '')), ''),
      NULLIF(trim(COALESCE(p_email,   '')), ''),
      NULLIF(trim(COALESCE(p_phone,   '')), ''),
      COALESCE(p_stage, 'new'),
      p_lead_type,
      p_value,
      p_source,
      NULLIF(trim(COALESCE(p_notes, '')), ''),
      now(),
      now()
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'duplicate', false);
  ELSE
    RETURN jsonb_build_object('id', v_lead.id, 'duplicate', true);
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assign_solar_lead(p_lead_id uuid, p_postcode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_client        record;
  v_lead          record;
  v_all_fields    jsonb;
  v_template      jsonb;
  v_field         jsonb;
  v_key           text;
  v_label         text;
  v_val           text;
  v_email_rows    text := '';
  v_sms_parts     text[] := ARRAY[]::text[];
  v_email_html    text;
  v_sms_body      text;
  v_rendered_keys text[] := ARRAY[]::text[];
BEGIN
  -- Step 1: fetch the lead
  SELECT * INTO v_lead FROM public.solar_leads WHERE id = p_lead_id;

  -- Step 2: find and lock the right client
  SELECT
    c.id, c.company_name, c.delivery_method,
    c.delivery_email, c.delivery_phone,
    c.custom_fields, c.lead_template,
    c.has_quoteleads_platform_account, c.platform_email, c.twilio_phone
  INTO v_client
  FROM public.clients c
  WHERE c.type  = 'ppl'
    AND c.stage = 'active_client'
    AND c.leads_delivered < (c.total_leads_purchased + COALESCE(c.leads_scrubbed, 0))
    AND p_postcode = ANY(c.postcodes)
    AND (
      c.weekly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('week', now())
      ) < c.weekly_cap
    )
    AND (
      c.monthly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('month', now())
      ) < c.monthly_cap
    )
  ORDER BY c.last_lead_delivered_at ASC NULLS FIRST
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_client.id IS NULL THEN
    RETURN jsonb_build_object('assigned', false, 'reason', 'no_matching_client');
  END IF;

  -- Step 3: merge lead fields, converting verified booleans to Yes/No
  v_all_fields := jsonb_build_object(
      'name',              v_lead.name,
      'email',             v_lead.email,
      'phone',             v_lead.phone,
      'postcode',          v_lead.postcode,
      'address',           v_lead.address,
      'suburb',            v_lead.suburb,
      'state',             v_lead.state,
      'is_homeowner',      v_lead.is_homeowner,
      'avg_quarterly_bill',v_lead.avg_quarterly_bill::text,
      'purchase_timeline', v_lead.purchase_timeline,
      'property_type',     v_lead.property_type,
      'roof_type',         v_lead.roof_type,
      'monthly_bill',      v_lead.monthly_bill::text,
      'system_size',       v_lead.system_size,
      'interested_in',     v_lead.interested_in,
      'phone_verified',    CASE WHEN v_lead.phone_verified THEN 'Yes' ELSE 'No' END,
      'email_verified',    CASE WHEN v_lead.email_verified THEN 'Yes' ELSE 'No' END
  );

  -- Step 4: resolve template
  v_template := COALESCE(
    v_client.lead_template,
    '[
      {"key":"name","label":"Name"},
      {"key":"email","label":"Email"},
      {"key":"phone","label":"Phone"},
      {"key":"postcode","label":"Postcode"},
      {"key":"is_homeowner","label":"Home Owner"},
      {"key":"avg_quarterly_bill","label":"Avg Quarterly Bill"},
      {"key":"purchase_timeline","label":"Purchase Timeline"}
    ]'::jsonb
  );

  -- Step 5: render template fields
  FOR v_field IN SELECT value FROM jsonb_array_elements(v_template) LOOP
    v_key   := v_field->>'key';
    v_label := COALESCE(v_field->>'label', v_key);
    v_val   := v_all_fields->>v_key;

    v_rendered_keys := v_rendered_keys || v_key;

    IF v_val IS NOT NULL AND trim(v_val) <> '' THEN
      v_email_rows := v_email_rows
        || '<tr><td style="padding:6px 12px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">' || v_label || '</td>'
        || '<td style="padding:6px 0;font-size:13px;color:#111">' || v_val || '</td></tr>';
      v_sms_parts := v_sms_parts || (v_label || ': ' || v_val);
    END IF;
  END LOOP;

  -- Step 5b: append solar_leads.custom_fields
  IF v_lead.custom_fields IS NOT NULL AND trim(v_lead.custom_fields) <> '' THEN
    v_email_rows := v_email_rows
      || '<tr><td style="padding:6px 12px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">Notes</td>'
      || '<td style="padding:6px 0;font-size:13px;color:#111">' || v_lead.custom_fields || '</td></tr>';
    v_sms_parts := v_sms_parts || ('Notes: ' || v_lead.custom_fields);
  END IF;

  v_email_html := '<div style="font-family:sans-serif;max-width:480px">'
                  || '<p style="font-size:15px;font-weight:600;margin:0 0 12px">New Solar Lead — ' || v_lead.name || '</p>'
                  || '<table style="border-collapse:collapse;width:100%">' || v_email_rows || '</table>'
                  || '<p style="font-size:11px;color:#aaa;margin:16px 0 0">Exclusive lead distributed to ' || v_client.company_name || ' · QL Mission Control</p>'
                  || '</div>';

  v_sms_body := array_to_string(v_sms_parts, ' | ');

  -- Step 6: increment client counters
  UPDATE public.clients
  SET leads_delivered = leads_delivered + 1,
      last_lead_delivered_at = now(),
      updated_at = now()
  WHERE id = v_client.id;

  -- Step 7: update the lead row
  UPDATE public.solar_leads
  SET assigned_client_id = v_client.id,
      assigned_at = now(),
      status = 'assigned',
      delivery_method = v_client.delivery_method,
      updated_at = now()
  WHERE id = p_lead_id;

  -- Step 8: return everything safely
  RETURN jsonb_build_object(
    'assigned', true,
    'client_id', v_client.id,
    'company_name', v_client.company_name,
    'delivery_method', v_client.delivery_method,
    'delivery_email', v_client.delivery_email,
    'delivery_phone', v_client.delivery_phone,
    'custom_fields', COALESCE(trim(both '"' from v_client.custom_fields::text), ''),
    'has_quoteleads_platform_account', v_client.has_quoteleads_platform_account,
    'platform_email', v_client.platform_email,
    'twilio_phone', v_client.twilio_phone,
    'email_subject', 'New Lead — ' || v_lead.name || ' (' || v_lead.postcode || ')',
    'email_html', v_email_html,
    'sms_body', v_sms_body
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.auto_assign_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rep     uuid;
  v_type    text;
  v_enabled boolean;
  v_fixed   uuid;
  v_mode    text;
  v_pool    text[];
  v_pick    text;
  v_n       bigint;
begin
  if NEW.owner_id is not null then
    return NEW;
  end if;

  v_type := auth.jwt() -> 'app_metadata' ->> 'account_type';
  if v_type = 'sales_rep' then
    NEW.owner_id := auth.uid();
    return NEW;
  end if;

  select auto_assign_enabled, auto_assign_rep_id, auto_assign_mode
    into v_enabled, v_fixed, v_mode
    from public.sales_rep_config where id = 1;

  if not coalesce(v_enabled, false) then
    return NEW;
  end if;

  v_mode := coalesce(v_mode, 'least_busy');

  -- ── Round robin: take the next slot in the configured pool ────────────────
  if v_mode = 'round_robin' then
    v_pool := public.round_robin_pool();
    if array_length(v_pool, 1) is null then
      return NEW;  -- nobody in the pool → leave it unassigned
    end if;

    -- Bump the cursor atomically; the row lock serialises concurrent inserts.
    update public.sales_rep_config
       set round_robin_cursor = round_robin_cursor + 1
     where id = 1
    returning round_robin_cursor into v_n;

    v_pick := v_pool[(v_n % array_length(v_pool, 1)) + 1];
    if v_pick is null or v_pick = 'house' then
      return NEW;  -- the main account's turn → stays unassigned, admin-only
    end if;
    NEW.owner_id := v_pick::uuid;
    return NEW;
  end if;

  -- ── Fixed rep (only while they are active) ────────────────────────────────
  if v_mode = 'fixed' and v_fixed is not null then
    select user_id into v_rep
      from public.sales_reps
      where user_id = v_fixed and active = true;
  end if;

  -- ── Least-loaded active rep (default, and the fallback for a dead fixed rep)
  if v_rep is null then
    select r.user_id into v_rep
      from public.sales_reps r
      where r.active = true
      order by (
        select count(*) from public.leads l
        where l.owner_id = r.user_id
          and coalesce(l.stage, '') not in ('closed_won', 'closed_lost', 'churned')
      ) asc, random()
      limit 1;
  end if;

  if v_rep is not null then
    NEW.owner_id := v_rep;
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.business_domain(p_website text, p_email text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(
    public.norm_domain(p_website),
    case when public.is_free_mail_domain(public.email_domain(p_email)) then null
         else public.email_domain(p_email) end)
$function$
;

CREATE OR REPLACE FUNCTION public.contact_is_suppressed(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.contact_suppressions s
     where (s.kind = 'email'  and s.value = public.norm_email(p_email))
        or (s.kind = 'phone'  and s.value = public.norm_au_phone(p_phone))
        or (s.kind = 'domain' and s.value = public.email_domain(p_email)
            and not public.is_free_mail_domain(public.email_domain(p_email)))
  )
$function$
;

CREATE OR REPLACE FUNCTION public.contact_suppress(p_kind text, p_value text, p_reason text, p_source text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v text := case p_kind
              when 'email'  then public.norm_email(p_value)
              when 'phone'  then public.norm_au_phone(p_value)
              when 'domain' then public.norm_domain(p_value)
            end;
begin
  if v is null or v = '' then
    raise exception 'Nothing to suppress.' using errcode = '22023';
  end if;
  if p_kind = 'domain' and public.is_free_mail_domain(v) then
    raise exception '% is webmail; suppress the email address instead.', v using errcode = '22023';
  end if;
  insert into public.contact_suppressions (kind, value, reason, source, note)
  values (p_kind, v, p_reason, p_source, p_note)
  on conflict (kind, value) do nothing;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.contact_suppressions_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.prospects p
     set status = 'blocked', status_reason = 'do not contact (' || new.reason || ')'
   where p.status in ('new', 'enriched', 'verified', 'qualified', 'queued')
     and ((new.kind = 'email'  and p.email = new.value)
       or (new.kind = 'phone'  and p.phone = new.value)
       or (new.kind = 'domain' and (p.domain = new.value or public.email_domain(p.email) = new.value)));
  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.email_domain(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(split_part(public.norm_email(p), '@', 2), '')
$function$
;

CREATE OR REPLACE FUNCTION public.find_leads_by_contact(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_limit integer DEFAULT 5)
 RETURNS TABLE(id uuid, name text, company text, email text, phone text, stage text, source text, created_at timestamp with time zone, matched_on text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH norm AS (
    SELECT nullif(lower(trim(coalesce(p_email, ''))), '')                   AS e,
           nullif(public.phone_digits9(coalesce(p_phone, '')), '')          AS d
  )
  SELECT l.id, l.name, l.company, l.email, l.phone, l.stage, l.source, l.created_at,
         CASE
           WHEN (SELECT e FROM norm) IS NOT NULL AND lower(l.email) = (SELECT e FROM norm)
             THEN 'email'
           ELSE 'phone'
         END AS matched_on
    FROM public.leads l, norm
   WHERE ((norm.e IS NOT NULL AND lower(l.email) = norm.e)
       OR (norm.d IS NOT NULL AND l.phone IS NOT NULL AND public.phone_digits9(l.phone) = norm.d))
   ORDER BY (CASE WHEN (SELECT e FROM norm) IS NOT NULL AND lower(l.email) = (SELECT e FROM norm) THEN 0 ELSE 1 END),
            l.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 5), 25));
$function$
;

CREATE OR REPLACE FUNCTION public.generate_invoice_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  next_num integer;
BEGIN
  SELECT COALESCE(
    MAX(CAST(SUBSTRING(invoice_number FROM 'QL-INV-(\d+)') AS integer)),
    0
  ) + 1 INTO next_num FROM invoices;
  NEW.invoice_number := 'QL-INV-' || LPAD(next_num::text, 4, '0');
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_meta_capi_token()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select nullif(decrypted_secret, '') from vault.decrypted_secrets where name = 'meta_capi_token'
$function$
;

CREATE OR REPLACE FUNCTION public.increment_leads_delivered(p_client_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  UPDATE clients
     SET leads_delivered = COALESCE(leads_delivered, 0) + 1
   WHERE id = p_client_id;
$function$
;

CREATE OR REPLACE FUNCTION public.is_free_mail_domain(p text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(lower(p), '') = any (array[
    'gmail.com','googlemail.com','outlook.com','outlook.com.au','hotmail.com','hotmail.com.au',
    'live.com','live.com.au','msn.com','yahoo.com','yahoo.com.au','ymail.com','icloud.com','me.com',
    'mac.com','bigpond.com','bigpond.net.au','bigpond.com.au','optusnet.com.au','iinet.net.au',
    'westnet.com.au','tpg.com.au','internode.on.net','dodo.com.au','aapt.net.au','ozemail.com.au',
    'adam.com.au','people.net.au','aol.com','protonmail.com','proton.me','gmx.com','mail.com',
    'zoho.com','fastmail.com','fastmail.fm'
  ])
$function$
;

CREATE OR REPLACE FUNCTION public.is_sales_rep()
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'account_type') = 'sales_rep',
    false
  );
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_action_log(p_limit integer DEFAULT 80)
 RETURNS TABLE(at timestamp with time zone, kind text, subject text, detail text, status text, ref jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acct text;
  lim  int;
begin
  acct := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  if acct in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if auth.jwt() is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  lim := least(greatest(coalesce(p_limit, 80), 1), 500);

  return query
  with log_rows as (
    select e.first_seen_at as at,
           'spotted'::text as kind,
           e.subject,
           e.kind || case when e.tier = 'urgent' then ' (urgent)' else '' end as detail,
           case when e.resolved_at is not null then 'resolved' else 'open' end as status,
           jsonb_strip_nulls(jsonb_build_object(
             'lead_id',   e.payload ->> 'lead_id',
             'client_id', e.payload ->> 'client_id',
             'days',      e.payload ->> 'days'
           )) as ref
    from public.jarvis_events e

    union all

    select n.created_at,
           case n.channel when 'call' then 'called_you' when 'panel' then 'told_you' else 'texted_you' end,
           null,
           n.body,
           n.status,
           jsonb_strip_nulls(jsonb_build_object('twilio_sid', n.twilio_sid, 'error', n.error))
    from public.jarvis_notifications n

    union all

    select m.created_at,
           case when m.direction = 'inbound' then 'you_said' else 'he_replied' end,
           null,
           m.body,
           case when m.error is not null then 'failed' else 'sent' end,
           jsonb_strip_nulls(jsonb_build_object('twilio_sid', m.twilio_sid, 'error', m.error))
    from public.jarvis_messages m

    union all

    select l.sent_at,
           'emailed_client',
           coalesce(nullif(ld.company, ''), ld.name, l.to_email),
           l.subject,
           'sent',
           jsonb_strip_nulls(jsonb_build_object(
             'lead_id', l.lead_id::text,
             'to',      l.to_email,
             'kind',    l.kind
           ))
    from public.sales_email_log l
    left join public.leads ld on ld.id = l.lead_id
    where l.via = 'jarvis'
  )
  select log_rows.at, log_rows.kind, log_rows.subject, log_rows.detail, log_rows.status, log_rows.ref
  from log_rows
  order by log_rows.at desc
  limit lim;
end $function$
;

CREATE OR REPLACE FUNCTION public.jarvis_apply_scan()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  opened integer;
begin
  drop table if exists _scan;
  create temp table _scan on commit drop as select * from public.jarvis_scan();

  insert into public.jarvis_events (kind, dedup_key, tier, subject, payload)
  select s.kind, s.dedup_key, s.tier, s.subject, s.payload from _scan s
  on conflict (dedup_key) do update
    set last_seen_at = now(),
        tier         = excluded.tier,
        subject      = excluded.subject,
        payload      = excluded.payload,
        notified_at  = case
                         -- Cold proposals are announced once and never again,
                         -- however many times they go quiet.
                         when public.jarvis_events.kind = 'proposal_cold'
                           then public.jarvis_events.notified_at
                         when public.jarvis_events.resolved_at is not null
                           then null
                         else public.jarvis_events.notified_at
                       end,
        resolved_at  = null;

  update public.jarvis_events e
     set resolved_at = now()
   where e.resolved_at is null
     and not exists (select 1 from _scan s where s.dedup_key = e.dedup_key);

  select count(*) into opened
  from public.jarvis_events
  where notified_at is null and resolved_at is null
    and (snoozed_until is null or snoozed_until < now());

  return opened;
end $function$
;

CREATE OR REPLACE FUNCTION public.jarvis_assert_operator()
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
begin
  if auth.jwt() is null
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '') in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_claim_due_jobs(p_limit integer DEFAULT 2, p_tz text DEFAULT 'Australia/Sydney'::text)
 RETURNS SETOF jarvis_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  with due as (
    select id from public.jarvis_jobs
     where active and next_run_at <= now()
     order by next_run_at
     limit least(greatest(coalesce(p_limit, 2), 1), 5)
     for update skip locked
  )
  update public.jarvis_jobs j
     set last_run_at = now(),
         runs        = j.runs + 1,
         active      = j.repeat <> 'once',
         next_run_at = public.jarvis_job_next_future(j.repeat, j.next_run_at, p_tz)
    from due
   where j.id = due.id
  returning j.*;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_inbox(p_limit integer DEFAULT 20)
 RETURNS TABLE(id uuid, tier text, body text, created_at timestamp with time zone, read_at timestamp with time zone, unread bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select n.id, n.tier, n.body, n.created_at, n.read_at,
           (select count(*) from public.jarvis_notifications u where u.channel = 'panel' and u.read_at is null)
      from public.jarvis_notifications n
     where n.channel = 'panel'
     order by n.created_at desc
     limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_inbox_read(p_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  update public.jarvis_notifications
     set read_at = now()
   where channel = 'panel' and read_at is null
     and (p_ids is null or id = any (p_ids));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_job_cancel(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  update public.jarvis_jobs set active = false where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_job_list()
 RETURNS TABLE(id uuid, title text, instruction text, repeat text, next_run_at timestamp with time zone, last_run_at timestamp with time zone, last_result text, runs integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select j.id, j.title, j.instruction, j.repeat, j.next_run_at, j.last_run_at, j.last_result, j.runs
      from public.jarvis_jobs j where j.active order by j.next_run_at nulls last limit 100;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_job_next(p_repeat text, p_from timestamp with time zone, p_tz text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  t timestamp := p_from at time zone p_tz;
begin
  if p_repeat = 'once' then return null; end if;
  loop
    t := t + case p_repeat
               when 'weekly'  then interval '7 days'
               when 'monthly' then interval '1 month'
               else interval '1 day'
             end;
    exit when p_repeat <> 'weekdays' or extract(isodow from t) < 6;
  end loop;
  return t at time zone p_tz;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_job_next_future(p_repeat text, p_from timestamp with time zone, p_tz text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  n timestamptz := public.jarvis_job_next(p_repeat, p_from, p_tz);
begin
  while n is not null and n <= now() loop
    n := public.jarvis_job_next(p_repeat, n, p_tz);
  end loop;
  return n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_memory_delete(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  delete from public.jarvis_memory where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_memory_list()
 RETURNS TABLE(id uuid, content text, source text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select m.id, m.content, m.source, m.created_at
      from public.jarvis_memory m order by m.created_at desc limit 500;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_memory_save(p_id uuid, p_content text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v text := btrim(coalesce(p_content, ''));
  out_id uuid;
begin
  perform public.jarvis_assert_operator();
  if v = '' or length(v) > 1000 then
    raise exception 'A memory is 1 to 1000 characters.' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.jarvis_memory (content, source) values (v, 'you') returning id into out_id;
  else
    update public.jarvis_memory set content = v, updated_at = now() where id = p_id returning id into out_id;
  end if;
  return out_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_outbox_claim(p_limit integer DEFAULT 5)
 RETURNS SETOF jarvis_outbox
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.jarvis_outbox o
     set status = 'sending', attempted_at = now()
   where o.id in (
     select id from public.jarvis_outbox
      where status = 'queued'
         or (status = 'sending' and attempted_at < now() - interval '10 minutes')
      order by created_at, id
      limit least(greatest(coalesce(p_limit, 5), 1), 25)
      for update skip locked)
  returning o.*
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_post_approve(p_id uuid, p_caption text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v text := btrim(coalesce(p_caption, ''));
begin
  perform public.jarvis_assert_operator();
  if v <> '' and length(v) > 2200 then
    raise exception 'A caption is at most 2200 characters.' using errcode = '22023';
  end if;
  update public.jarvis_posts p
     set original_caption = case when v <> '' and v <> p.caption
                                 then coalesce(p.original_caption, p.caption)
                                 else p.original_caption end,
         caption     = case when v <> '' then v else p.caption end,
         status      = 'approved',
         approved_at = now(),
         updated_at  = now()
   where p.id = p_id and p.status in ('draft', 'approved');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_post_list(p_limit integer DEFAULT 40)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, caption text, original_caption text, platforms text[], card jsonb, facts jsonb, image_url text, editor_score numeric, editor_notes text, status text, approved_at timestamp with time zone, posted_at timestamp with time zone, source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select p.id, p.created_at, p.caption, p.original_caption, p.platforms, p.card, p.facts,
           p.image_url, p.editor_score, p.editor_notes, p.status, p.approved_at, p.posted_at, p.source
      from public.jarvis_posts p
     where p.status <> 'rejected'
     order by (p.status = 'draft') desc, (p.status = 'approved') desc, p.created_at desc
     limit least(greatest(coalesce(p_limit, 40), 1), 200);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_post_set_status(p_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  if p_status not in ('posted', 'rejected', 'approved') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  update public.jarvis_posts
     set status = p_status,
         posted_at = case when p_status = 'posted' then now() else posted_at end,
         updated_at = now()
   where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_scan()
 RETURNS TABLE(kind text, dedup_key text, tier text, subject text, payload jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select * from public.jarvis_scan_base()
  union all
  select a.kind, a.dedup_key, a.tier, a.subject, a.payload from public.managed_alerts a where a.active
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_scan_base()
 RETURNS TABLE(kind text, dedup_key text, tier text, subject text, payload jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select
    'proposal_cold'::text,
    'proposal_cold:' || l.id::text,
    case when t.touched < now() - interval '14 days' then 'urgent' else 'notable' end,
    coalesce(nullif(l.company, ''), l.name, 'Unnamed lead'),
    jsonb_build_object(
      'lead_id', l.id,
      'days', floor(extract(epoch from (now() - t.touched)) / 86400),
      'value', l.value,
      'followed_up', l.followup_sent_at is not null
    )
  from public.leads l
  cross join lateral (
    select greatest(
      l.updated_at,
      coalesce(l.followup_sent_at, l.updated_at),
      coalesce(l.info_sent_at,     l.updated_at),
      coalesce(l.last_contact,     l.updated_at)
    ) as touched
  ) t
  where l.stage = 'proposal'
    and t.touched < now() - interval '7 days'

  union all

  select
    'followup_overdue'::text,
    'followup_overdue:' || l.id::text,
    'notable'::text,
    coalesce(nullif(l.company, ''), l.name, 'Unnamed lead'),
    jsonb_build_object('lead_id', l.id, 'due', l.next_followup, 'stage', l.stage,
      'last_contact', l.last_contact)
  from public.leads l
  where l.next_followup is not null
    -- Somebody has actually spoken to them. Without this, the date the intake
    -- sets on every web enquiry reads as a missed commitment.
    and l.last_contact is not null
    -- Strictly before today in the business's timezone: due today is due, not
    -- late, and UTC would call a Sydney date late while it is still morning.
    and l.next_followup < (now() at time zone coalesce(
          (select nullif(jarvis_timezone, '') from public.business_settings limit 1),
          'Australia/Sydney'))::date
    and l.stage not in ('closed_won', 'closed_lost')

  union all

  select
    'fulfilment_overdue'::text,
    'fulfilment_overdue:' || c.id::text,
    'notable'::text,
    coalesce(nullif(c.company_name, ''), 'Unnamed client'),
    jsonb_build_object('client_id', c.id, 'step', c.fulfilment_next_step,
      'due', c.fulfilment_next_due)
  from public.clients c
  where c.fulfilment_next_due is not null and c.fulfilment_next_due < now()
    and coalesce(c.stage, '') not in ('churned', 'paused')

  union all

  select
    'fulfilment_blocked'::text,
    'fulfilment_blocked:' || c.id::text,
    'urgent'::text,
    coalesce(nullif(c.company_name, ''), 'Unnamed client'),
    jsonb_build_object('client_id', c.id, 'blocked', c.fulfilment_blocked_count)
  from public.clients c
  where coalesce(c.fulfilment_blocked_count, 0) > 0
    and coalesce(c.stage, '') not in ('churned', 'paused')

  union all

  select
    'don_off'::text,
    'don_off'::text,
    'notable'::text,
    'AI SMS agent',
    jsonb_build_object(
      'waiting', w.n,
      'since_hours', floor(extract(epoch from (now() - w.oldest)) / 3600),
      'config_inactive', bs.don_active is false
    )
  from public.business_settings bs
  cross join lateral (
    select count(*) as n, min(s.created_at) as oldest
    from public.sales_sms_log s
    where s.direction = 'inbound'
      and s.created_at > now() - interval '72 hours'
  ) w
  where bs.don_enabled is false
    and bs.don_synced_at is not null
    and bs.don_synced_at > now() - interval '2 hours'
    and w.n > 0;
$function$
;

CREATE OR REPLACE FUNCTION public.jarvis_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acct text;
  result jsonb;
begin
  if auth.jwt() is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  acct := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  if acct in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'open_by_kind', coalesce((
      select jsonb_object_agg(kind, n)
      from (
        select kind, count(*) as n
        from public.jarvis_events
        where resolved_at is null
        group by kind
      ) k
    ), '{}'::jsonb),
    'open_total', (select count(*) from public.jarvis_events where resolved_at is null),
    'queued', (
      select count(*) from public.jarvis_events
      where resolved_at is null and notified_at is null
        and (snoozed_until is null or snoozed_until < now())
    ),
    'last_sent_at', (select max(created_at) from public.jarvis_notifications where status='sent'),
    'last_body', (
      select body from public.jarvis_notifications
      where status='sent' order by created_at desc limit 1
    )
  ) into result;

  return result;
end $function$
;

CREATE OR REPLACE FUNCTION public.jarvis_usage_summary(p_tz text DEFAULT 'Australia/Sydney'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acct  text;
  tz    text;
  today date;
  month_start date;
  last_month_start date;
  result jsonb;
begin
  if auth.jwt() is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  acct := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  if acct in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  tz := case when exists (select 1 from pg_timezone_names where name = p_tz)
             then p_tz else 'Australia/Sydney' end;
  today            := (now() at time zone tz)::date;
  month_start      := date_trunc('month', today)::date;
  last_month_start := (month_start - interval '1 month')::date;

  with u as (
    select (created_at at time zone tz)::date as day, *
    from public.jarvis_usage
    where created_at >= (last_month_start::timestamp at time zone tz)
  ),
  totals as (
    select
      coalesce(sum(cost_usd) filter (where day = today), 0)              as today_cost,
      count(*)               filter (where day = today)                  as today_q,
      coalesce(sum(cost_usd) filter (where day >= month_start), 0)       as month_cost,
      count(*)               filter (where day >= month_start)           as month_q,
      coalesce(sum(web_searches) filter (where day >= month_start), 0)   as month_searches,
      coalesce(sum(cost_usd) filter (where day < month_start), 0)        as last_cost,
      count(*)               filter (where day < month_start)            as last_q
    from u
  ),
  days as (
    select day, sum(cost_usd) as cost, count(*) as questions
    from u where day >= today - 29
    group by day order by day
  )
  select jsonb_build_object(
    'today',      jsonb_build_object('cost_usd', t.today_cost, 'questions', t.today_q),
    'month',      jsonb_build_object('cost_usd', t.month_cost, 'questions', t.month_q,
                                     'web_searches', t.month_searches,
                                     'avg_per_question', case when t.month_q > 0
                                       then round(t.month_cost / t.month_q, 4) else 0 end),
    'last_month', jsonb_build_object('cost_usd', t.last_cost, 'questions', t.last_q),
    'all_time',   (select jsonb_build_object('cost_usd', coalesce(sum(cost_usd), 0),
                                             'questions', count(*),
                                             'since', min(created_at))
                   from public.jarvis_usage),
    'by_day',     coalesce((select jsonb_agg(jsonb_build_object(
                                'day', d.day, 'cost_usd', d.cost, 'questions', d.questions))
                            from days d), '[]'::jsonb)
  )
  into result
  from totals t;

  return result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.leads_stamp_stage_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.managed_active_default_ads_live()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.type = 'managed' and new.stage = 'active'
     and (new.active_status is null or new.active_status = '') then
    new.active_status := 'Ads Live';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_followup_done(p_lead uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  update public.leads
     set last_contact = now(),
         contact_count = coalesce(contact_count, 0) + 1,
         next_followup = null,
         updated_at = now()
   where id = p_lead
     and (not public.is_sales_rep() or owner_id = auth.uid());
  if not found then
    raise exception 'lead not found or not yours';
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_lead_delivered(p_lead_id uuid, p_note text DEFAULT 'Marked delivered'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_lead  record;
  v_entry text;
BEGIN
  SELECT * INTO v_lead FROM public.solar_leads WHERE id = p_lead_id;

  IF v_lead IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lead_not_found');
  END IF;

  v_entry := '[' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI UTC') || '] ' || p_note;

  UPDATE public.solar_leads
  SET status             = 'delivered',
      delivered_at       = COALESCE(delivered_at, now()),
      delivery_audit_log = CASE
                             WHEN delivery_audit_log IS NULL THEN v_entry
                             ELSE delivery_audit_log || E'\n' || v_entry
                           END,
      updated_at         = now()
  WHERE id = p_lead_id;

  RETURN jsonb_build_object('ok', true, 'lead_id', p_lead_id, 'note', v_entry);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_lead_scrubbed(p_lead_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_client_id   uuid;
  v_prev_status text;
BEGIN
  SELECT assigned_client_id, status
    INTO v_client_id, v_prev_status
    FROM ppl_leads
   WHERE id = p_lead_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead not found: %', p_lead_id;
  END IF;

  -- idempotent: already scrubbed means nothing to do, no counter movement
  IF v_prev_status = 'scrubbed' THEN
    RETURN false;
  END IF;

  UPDATE ppl_leads
     SET status = 'scrubbed', updated_at = now()
   WHERE id = p_lead_id;

  IF v_client_id IS NOT NULL THEN
    UPDATE clients
       SET leads_delivered = CASE
             WHEN v_prev_status = 'delivered'
               THEN GREATEST(COALESCE(leads_delivered, 0) - 1, 0)
             ELSE COALESCE(leads_delivered, 0)
           END,
           leads_scrubbed = COALESCE(leads_scrubbed, 0) + 1
     WHERE id = v_client_id;
  END IF;

  RETURN true;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.norm_au_phone(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p is null then null
    else (
      select case
        when v like '04%'  then '+61' || substr(v, 2)
        when v like '614%' then '+' || v
        when v like '61%'  then '+' || v
        else v
      end
      from (select regexp_replace(p, '[\s\-().]', '', 'g') as v) s
    )
  end
$function$
;

CREATE OR REPLACE FUNCTION public.norm_domain(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(coalesce(p, ''))), '^[a-z]+://', ''),
        '^www\.', ''),
      '[/:?#].*$', ''),
    '')
$function$
;

CREATE OR REPLACE FUNCTION public.norm_email(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(lower(btrim(coalesce(p, ''))), '')
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_batch_approve(p_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record; why text; queued int := 0; skipped jsonb := '[]'::jsonb;
begin
  perform public.jarvis_assert_operator();
  if coalesce(array_length(p_ids, 1), 0) > 500 then raise exception 'At most 500 at once' using errcode = '22023'; end if;
  for r in
    select p.*, n.sequence_approved_at, n.instantly_campaign_id
      from public.prospects p join public.outreach_niches n on n.key = p.niche_key
     where p.id = any (p_ids)
     for update of p
  loop
    why := case
      when r.status <> 'qualified'                          then 'no longer ready for review (' || r.status || ')'
      when r.email is null                                  then 'no email'
      when r.email_source_url is null                       then 'no record of where the email was published'
      when r.email_verdict = 'invalid'                      then 'email failed verification'
      when r.sequence_approved_at is null                   then 'its niche has no approved sequence'
      when r.instantly_campaign_id is null                  then 'its niche has no Instantly campaign yet'
      else public.prospect_block_reason(r.email, r.phone, r.domain, r.id)
    end;
    if why is null then
      update public.prospects set status = 'queued', queued_at = now(), status_reason = null where id = r.id;
      queued := queued + 1;
    else
      skipped := skipped || jsonb_build_object('id', r.id, 'business', r.business_name, 'reason', why);
    end if;
  end loop;
  return jsonb_build_object('queued', queued, 'skipped', skipped);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_batch_candidates(p_limit integer DEFAULT 200)
 RETURNS TABLE(id uuid, niche_key text, business_name text, website text, email text, email_source_url text, contact_name text, suburb text, state text, fit_score numeric, opener text, status_reason text, found_at timestamp with time zone, sequence_ready boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select p.id, p.niche_key, p.business_name, p.website, p.email, p.email_source_url,
           p.contact_name, p.suburb, p.state, p.fit_score, p.opener, p.status_reason, p.found_at,
           (n.sequence_approved_at is not null and n.instantly_campaign_id is not null)
      from public.prospects p
      join public.outreach_niches n on n.key = p.niche_key
     where p.status = 'qualified'
     order by p.fit_score desc nulls last, p.found_at
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_bounce_rate(p_niche text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'emailed', count(*) filter (where contacted_at >= now() - interval '7 days'),
    'bounced', count(*) filter (where status = 'bounced' and last_event_at >= now() - interval '7 days'))
    from public.prospects where niche_key = p_niche
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_campaign_list()
 RETURNS TABLE(key text, label text, enabled boolean, offer text, sequence jsonb, sequence_approved_at timestamp with time zone, instantly_campaign_id text, campaign_synced_at timestamp with time zone, campaign_state text, queued bigint, contacted bigint, replied bigint, interested bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select n.key, n.label, n.enabled, n.offer, n.sequence, n.sequence_approved_at,
           n.instantly_campaign_id, n.campaign_synced_at, n.campaign_state,
           (select count(*) from public.prospects p where p.niche_key = n.key and p.status = 'queued'),
           (select count(*) from public.prospects p where p.niche_key = n.key and p.contacted_at is not null),
           (select count(*) from public.prospects p where p.niche_key = n.key and p.status in ('replied', 'interested', 'not_interested', 'converted')),
           (select count(*) from public.prospects p where p.niche_key = n.key and p.status in ('interested', 'converted'))
      from public.outreach_niches n
     order by n.sort_order, n.key;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_claim(p_channel text, p_recipient text, p_message text, p_lead_id uuid DEFAULT NULL::uuid, p_days integer DEFAULT 30)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rec  text := public.outreach_recipient(p_channel, p_recipient);
  v_hash text := public.outreach_hash(p_message);
  v_ok   boolean;
begin
  if v_rec is null or v_rec = '' then
    return false;
  end if;
  insert into public.outreach_sent as o (channel, recipient, msg_hash, lead_id, claimed_at)
  values (p_channel, v_rec, v_hash, p_lead_id, now())
  on conflict (channel, recipient, msg_hash)
  do update set claimed_at = now(), lead_id = coalesce(excluded.lead_id, o.lead_id)
   where o.claimed_at < now() - make_interval(days => greatest(coalesce(p_days, 30), 0))
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_daily(p_days integer DEFAULT 30)
 RETURNS TABLE(day date, emailed bigint, replies bigint, interested bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d int := least(greatest(coalesce(p_days, 30), 7), 180);
begin
  perform public.jarvis_assert_operator();
  return query
    with days as (
      select generate_series((now() at time zone 'Australia/Brisbane')::date - (d - 1),
                             (now() at time zone 'Australia/Brisbane')::date, interval '1 day')::date as day
    )
    select days.day,
           (select count(*) from public.prospects p where (p.contacted_at at time zone 'Australia/Brisbane')::date = days.day),
           (select count(*) from public.outreach_events e where e.event_type = 'reply_received' and (e.received_at at time zone 'Australia/Brisbane')::date = days.day),
           (select count(*) from public.outreach_events e where e.event_type in ('lead_interested', 'lead_meeting_booked') and (e.received_at at time zone 'Australia/Brisbane')::date = days.day)
      from days order by days.day;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_event_list(p_limit integer DEFAULT 50)
 RETURNS TABLE(received_at timestamp with time zone, event_type text, lead_email text, business_name text, subject text, body text, handled text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select e.received_at, e.event_type, e.lead_email, p.business_name, e.subject, left(e.body, 600), e.handled
      from public.outreach_events e left join public.prospects p on p.id = e.prospect_id
     order by e.received_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_funnel(p_days integer DEFAULT NULL::integer)
 RETURNS TABLE(niche_key text, label text, found bigint, with_email bigint, verified bigint, qualified bigint, emailed bigint, replied bigint, interested bigint, won bigint, won_value numeric, bounced bigint, unsubscribed bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    with p as (
      select p.*,
             exists (select 1 from public.outreach_events e where e.prospect_id = p.id and e.event_type = 'reply_received') as got_reply,
             l.stage as lead_stage, l.value as lead_value
        from public.prospects p
        left join public.leads l on l.id = p.lead_id
       where p_days is null or p.found_at >= now() - make_interval(days => p_days)
    )
    select n.key, n.label,
           count(p.id),
           count(p.id) filter (where p.email is not null),
           count(p.id) filter (where p.email_verdict in ('valid', 'risky')),
           count(p.id) filter (where p.fit_score >= 6),
           count(p.id) filter (where p.contacted_at is not null),
           count(p.id) filter (where p.got_reply or p.status in ('replied', 'interested', 'not_interested', 'converted')),
           count(p.id) filter (where p.status in ('interested', 'converted') or p.lead_id is not null),
           count(p.id) filter (where p.lead_stage = 'closed_won'),
           coalesce(sum(p.lead_value) filter (where p.lead_stage = 'closed_won'), 0),
           count(p.id) filter (where p.status = 'bounced'),
           count(p.id) filter (where p.status = 'unsubscribed')
      from public.outreach_niches n
      left join p on p.niche_key = n.key
     group by n.key, n.label, n.sort_order
     order by n.sort_order, n.key;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_hash(p_message text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select md5(btrim(regexp_replace(
           regexp_replace(lower(coalesce(p_message, '')), 'reply stop to opt out\.?', '', 'g'),
           '\s+', ' ', 'g')))
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_niche_list()
 RETURNS TABLE(key text, label text, enabled boolean, daily_target integer, regions text[], search_terms text[], offer text, notes text, counts jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select n.key, n.label, n.enabled, n.daily_target, n.regions, n.search_terms, n.offer, n.notes,
           coalesce((select jsonb_object_agg(s.status, s.c)
                       from (select p.status, count(*) c from public.prospects p
                              where p.niche_key = n.key group by p.status) s), '{}'::jsonb)
      from public.outreach_niches n
     order by n.sort_order, n.key;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_niche_update(p_key text, p_enabled boolean, p_daily_target integer, p_regions text[], p_search_terms text[], p_offer text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  update public.outreach_niches
     set enabled      = coalesce(p_enabled, enabled),
         daily_target = least(greatest(coalesce(p_daily_target, daily_target), 0), 300),
         regions      = coalesce((select array_agg(btrim(x)) from unnest(p_regions) x where btrim(x) <> ''), '{}'),
         search_terms = coalesce((select array_agg(btrim(x)) from unnest(p_search_terms) x where btrim(x) <> ''), '{}'),
         offer        = nullif(btrim(coalesce(p_offer, '')), ''),
         updated_at   = now()
   where key = p_key;
  if not found then raise exception 'No niche %', p_key using errcode = '22023'; end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_recipient(p_channel text, p_recipient text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when p_channel = 'sms' then public.norm_au_phone(p_recipient)
              else lower(btrim(coalesce(p_recipient, ''))) end
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_release(p_channel text, p_recipient text, p_message text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  delete from public.outreach_sent
   where channel = p_channel
     and recipient = public.outreach_recipient(p_channel, p_recipient)
     and msg_hash = public.outreach_hash(p_message)
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_run_list(p_limit integer DEFAULT 10)
 RETURNS SETOF outreach_runs
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select * from public.outreach_runs order by started_at desc
     limit least(greatest(coalesce(p_limit, 10), 1), 50);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_run_now()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  if exists (select 1 from public.outreach_runs where finished_at is null and started_at > now() - interval '15 minutes') then
    raise exception 'A run is already going' using errcode = '55000';
  end if;
  perform net.http_post(
    url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/outreach-find',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
    body    := '{"action":"run","trigger":"manual"}'::jsonb,
    timeout_milliseconds := 5000);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_sequence_save(p_key text, p_steps jsonb, p_approve boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s jsonb; n int; i int := 0;
begin
  perform public.jarvis_assert_operator();
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Steps must be a list' using errcode = '22023'; end if;
  n := jsonb_array_length(p_steps);
  if n < 1 or n > 4 then raise exception 'A sequence has 1 to 4 emails' using errcode = '22023'; end if;
  for s in select * from jsonb_array_elements(p_steps) loop
    i := i + 1;
    if i = 1 and coalesce(btrim(s->>'subject'), '') = '' then
      raise exception 'The first email needs a subject' using errcode = '22023';
    end if;
    if coalesce(btrim(s->>'body'), '') = '' then
      raise exception 'Every email needs a body' using errcode = '22023';
    end if;
    if coalesce((s->>'delay_days')::int, 0) not between 0 and 30 then
      raise exception 'Waits are 0 to 30 days' using errcode = '22023';
    end if;
  end loop;
  update public.outreach_niches
     set sequence = p_steps,
         sequence_approved_at = case when p_approve then now() else null end,
         updated_at = now()
   where key = p_key;
  if not found then raise exception 'No niche %', p_key using errcode = '22023'; end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_settings_get()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.outreach_settings;
begin
  perform public.jarvis_assert_operator();
  select * into r from public.outreach_settings where id = 1;
  return jsonb_build_object(
    'sender_name', r.sender_name, 'business_name', r.business_name, 'postal_address', r.postal_address,
    'sending_accounts', to_jsonb(r.sending_accounts), 'send_from', r.send_from, 'send_to', r.send_to,
    'timezone', r.timezone, 'daily_limit', r.daily_limit,
    'webhook_connected', r.webhook_id is not null, 'updated_at', r.updated_at);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_settings_update(p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  update public.outreach_settings set
    sender_name      = case when p ? 'sender_name' then nullif(btrim(p->>'sender_name'), '') else sender_name end,
    business_name    = coalesce(nullif(btrim(p->>'business_name'), ''), business_name),
    postal_address   = coalesce(nullif(btrim(p->>'postal_address'), ''), postal_address),
    sending_accounts = case when p ? 'sending_accounts'
                            then coalesce((select array_agg(lower(btrim(x))) from jsonb_array_elements_text(p->'sending_accounts') x where btrim(x) <> ''), '{}')
                            else sending_accounts end,
    send_from        = coalesce(nullif(p->>'send_from', ''), send_from),
    send_to          = coalesce(nullif(p->>'send_to', ''), send_to),
    timezone         = coalesce(nullif(p->>'timezone', ''), timezone),
    daily_limit      = coalesce((p->>'daily_limit')::int, daily_limit),
    updated_at       = now()
  where id = 1;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.outreach_spend(p_days integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return (select jsonb_build_object(
            'runs', count(*), 'searches', coalesce(sum(searches), 0), 'verified', coalesce(sum(verified + invalid), 0),
            'ai_cost_usd', coalesce(sum(ai_cost_usd), 0))
            from public.outreach_runs
           where p_days is null or started_at >= now() - make_interval(days => p_days));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.phone_digits9(p_phone text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
$function$
;

CREATE OR REPLACE FUNCTION public.preview_postcode_match(p_postcode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_client record;
BEGIN
  -- Same matching logic as assign_and_deliver_lead, but read-only (no locks, no updates)
  SELECT c.id, c.company_name
  INTO v_client
  FROM public.clients c
  WHERE c.type  = 'ppl'
    AND c.stage = 'active_client'
    AND c.leads_delivered < (c.total_leads_purchased + COALESCE(c.leads_scrubbed, 0))
    AND p_postcode = ANY(c.postcodes)
    AND (
      c.weekly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('week', now())
      ) < c.weekly_cap
    )
    AND (
      c.monthly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('month', now())
      ) < c.monthly_cap
    )
  ORDER BY c.last_lead_delivered_at ASC NULLS FIRST
  LIMIT 1;

  IF v_client.id IS NULL THEN
    RETURN jsonb_build_object('buyer_name', null, 'buyer_id', null);
  END IF;

  RETURN jsonb_build_object(
    'buyer_name', v_client.company_name,
    'buyer_id', v_client.id
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prospect_add(p jsonb)
 RETURNS TABLE(id uuid, status text, status_reason text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.prospects as x
    (niche_key, business_name, website, phone, address, suburb, state, postcode,
     google_place_id, source, source_ref, meta)
  values
    (p->>'niche_key', p->>'business_name', p->>'website', p->>'phone', p->>'address',
     p->>'suburb', p->>'state', p->>'postcode', p->>'google_place_id',
     coalesce(p->>'source', 'google_places'), p->>'source_ref', coalesce(p->'meta', '{}'::jsonb))
  on conflict do nothing
  returning x.id, x.status, x.status_reason
$function$
;

CREATE OR REPLACE FUNCTION public.prospect_block_reason(p_email text, p_phone text, p_domain text, p_exclude uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e text := public.norm_email(p_email);
  ph text := public.norm_au_phone(p_phone);
  d text := case when public.is_free_mail_domain(p_domain) then null else public.norm_domain(p_domain) end;
  r text;
begin
  select 'do not contact (' || s.reason || ')' into r
    from public.contact_suppressions s
   where (s.kind = 'email' and s.value = e)
      or (s.kind = 'phone' and s.value = ph)
      or (s.kind = 'domain' and s.value in (d, public.email_domain(e)))
   limit 1;
  if r is not null then return r; end if;

  if ph is not null and exists (select 1 from public.sms_opt_outs o where o.phone = ph and o.opted_out) then
    return 'opted out of SMS';
  end if;

  if (e is not null and exists (select 1 from public.leads l where public.norm_email(l.email) = e))
     or (ph is not null and exists (select 1 from public.leads l where public.norm_au_phone(l.phone) = ph))
     or (d is not null and exists (select 1 from public.leads l where public.email_domain(l.email) = d)) then
    return 'already in the sales pipeline';
  end if;

  if (e is not null and exists (select 1 from public.clients c where public.norm_email(c.email) = e))
     or (ph is not null and exists (select 1 from public.clients c where public.norm_au_phone(c.phone) = ph))
     or (d is not null and exists (select 1 from public.clients c where public.email_domain(c.email) = d)) then
    return 'already a client';
  end if;

  if ph is not null and exists (select 1 from public.prospects p where p.phone = ph and p.id is distinct from p_exclude) then
    return 'duplicate of another prospect (same phone)';
  end if;

  return null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.prospect_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  begin
    perform public.jarvis_assert_operator();

      select p.* into r
          from public.prospects p
             where p.id = p_id;

               if not found then
                   raise exception 'No such prospect' using errcode = '22023';
                     end if;

                       if r.instantly_pushed_at is not null then
                           raise exception 'Already pushed to a campaign - cannot delete' using errcode = '22023';
                             end if;

                               if r.status in ('contacted', 'replied', 'interested', 'not_interested', 'unsubscribed', 'bounced', 'converted') then
                                   raise exception 'Already contacted or converted - cannot delete' using errcode = '22023';
                                     end if;

                                       delete from public.prospects where id = p_id;

                                         return jsonb_build_object('ok', true, 'deleted', p_id);
                                         end;
                                         $function$
;

CREATE OR REPLACE FUNCTION public.prospect_list(p_niche text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, niche_key text, business_name text, website text, email text, email_source_url text, contact_name text, contact_role text, phone text, suburb text, state text, status text, status_reason text, email_verdict text, fit_score numeric, opener text, source text, found_at timestamp with time zone, contacted_at timestamp with time zone, total bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public.jarvis_assert_operator();
  return query
    select p.id, p.niche_key, p.business_name, p.website, p.email, p.email_source_url,
           p.contact_name, p.contact_role, p.phone, p.suburb, p.state, p.status,
           p.status_reason, p.email_verdict, p.fit_score, p.opener, p.source,
           p.found_at, p.contacted_at, count(*) over () as total
      from public.prospects p
     where (p_niche  is null or p.niche_key = p_niche)
       and (p_status is null or p.status = p_status)
       and (q is null
            or p.business_name ilike '%' || q || '%'
            or p.email         ilike '%' || q || '%'
            or p.domain        ilike '%' || q || '%'
            or p.suburb        ilike '%' || q || '%')
     order by p.found_at desc, p.id
     limit  least(greatest(coalesce(p_limit, 50), 1), 200)
     offset greatest(coalesce(p_offset, 0), 0);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.prospect_set_opener(p_id uuid, p_opener text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  update public.prospects set opener = nullif(btrim(p_opener), '') where id = p_id and status = 'qualified';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.prospects_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  why text;
begin
  new.email      := public.norm_email(new.email);
  new.phone      := public.norm_au_phone(new.phone);
  new.abn        := nullif(regexp_replace(coalesce(new.abn, ''), '\D', '', 'g'), '');
  new.domain     := public.business_domain(new.website, new.email);
  new.updated_at := now();

  if tg_op = 'INSERT'
     or new.email is distinct from old.email
     or new.phone is distinct from old.phone
     or new.domain is distinct from old.domain then
    if new.status in ('new', 'enriched', 'verified', 'qualified', 'queued', 'blocked') then
      why := public.prospect_block_reason(new.email, new.phone, new.domain, new.id);
      if why is not null then
        new.status := 'blocked';
        new.status_reason := why;
      elsif new.status = 'blocked' then
        new.status := 'new';
        new.status_reason := null;
      end if;
    end if;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.rep_commission_summary(p_rep uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acct text := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  v_rep uuid;
  v_name text;
  r jsonb;
begin
  if auth.uid() is null or acct in ('lead_buyer', 'sales_rep') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  v_rep := coalesce(p_rep, auth.uid());
  select name into v_name from public.sales_reps where user_id = v_rep;
  if v_name is null or btrim(v_name) = '' then
    return jsonb_build_object('rep', false);
  end if;

  with won as (
    select l.value,
           (select pr.amount from public.pay_rates pr
             where pr.rate_type = 'commission'
               and lower(pr.role_type) like lower(btrim(v_name)) || ' -%'
               and case when l.lead_type = 'managed' then pr.role_type ilike '%managed%'
                        else pr.role_type ilike '%ppl%' end
             order by pr.created_at desc limit 1) as pct
      from public.leads l
     where l.owner_id = v_rep and l.stage = 'closed_won'
  ), priced as (
    select value, pct, round(value / 1.1 * pct / 100, 2) as commission
      from won where coalesce(value, 0) > 0 and pct is not null
  )
  select jsonb_build_object(
    'rep', true,
    'name', v_name,
    'closes', (select count(*) from won),
    'priced', (select count(*) from priced),
    'no_value', (select count(*) from won where coalesce(value, 0) <= 0),
    'no_rate', (select count(*) from won where coalesce(value, 0) > 0 and pct is null),
    'total', coalesce((select sum(commission) from priced), 0),
    'average', (select round(avg(commission), 2) from priced))
  into r;
  return r;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.rep_update_lead_stage(p_lead_id uuid, p_stage text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
begin
  if not public.is_sales_rep() then
    raise exception 'rep_update_lead_stage is for sales reps only';
  end if;
  select owner_id into v_owner from public.leads where id = p_lead_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'not authorised for this lead';
  end if;
  if p_stage not in ('new_lead','no_answer','call_back','proposal','closed_won','closed_lost') then
    raise exception 'invalid stage: %', p_stage;
  end if;
  update public.leads
     set stage = p_stage,
         contactable = case when p_stage in ('call_back','proposal','closed_won') then true else contactable end,
         updated_at = now()
   where id = p_lead_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.round_robin_pool()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(e order by ord), '{}'::text[])
  from (select cfg.round_robin_pool from public.sales_rep_config cfg where cfg.id = 1) c,
       unnest(c.round_robin_pool) with ordinality as t(e, ord)
  where e = 'house'
     or exists (select 1 from public.sales_reps r where r.active and r.user_id::text = e);
$function$
;

CREATE OR REPLACE FUNCTION public.send_meta_conversion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_event text := case new.stage
    when 'call_back' then 'Schedule'
    when 'proposal' then 'QuoteSent'
    when 'closed_won' then 'Purchase'
  end;
begin
  if v_event is null or old.stage is not distinct from new.stage then
    return new;
  end if;
  -- Online checkout: already reported by the site pixel.
  if v_event = 'Purchase' and new.hq_company_id is not null and old.hq_company_id is null then
    return new;
  end if;
  if not exists (select 1 from public.business_settings where meta_dataset_id is not null) then
    return new;
  end if;

  perform net.http_post(
    url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/meta-capi',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
    body    := jsonb_build_object('action', 'send', 'lead_id', new.id, 'event', v_event),
    timeout_milliseconds := 30000
  );
  return new;
exception
  when others then
    raise warning 'send_meta_conversion failed: %', sqlerrm;
    return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_invoice_number()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if NEW.invoice_number is null then
    NEW.invoice_number := 'INV-' || lpad(nextval('public.invoice_number_seq')::text, 4, '0');
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_invoice_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.owner_id is null then
    NEW.owner_id := auth.uid();
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_meta_capi_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_secret uuid;
begin
  if auth.role() <> 'service_role' and (auth.uid() is null or public.is_sales_rep()) then
    raise exception 'not allowed';
  end if;
  select id into v_secret from vault.secrets where name = 'meta_capi_token';
  if v_secret is null then
    perform vault.create_secret(coalesce(p_token, ''), 'meta_capi_token');
  else
    perform vault.update_secret(v_secret, coalesce(p_token, ''));
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
    new.updated_at = now();
    return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sms_is_opted_out(p_phone text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
           select 1 from public.sms_opt_outs o
            where o.phone = public.norm_au_phone(p_phone) and o.opted_out
         )
      or exists (
           select 1 from public.leads l
            where l.sms_opted_out = true
              and public.norm_au_phone(l.phone) = public.norm_au_phone(p_phone)
         )
$function$
;

CREATE OR REPLACE FUNCTION public.sms_set_opt_out(p_phone text, p_opted_out boolean, p_source text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone text := public.norm_au_phone(p_phone);
begin
  if v_phone is null or v_phone = '' then
    return;
  end if;
  insert into public.sms_opt_outs (phone, opted_out, source, updated_at)
  values (v_phone, p_opted_out, p_source, now())
  on conflict (phone)
  do update set opted_out = excluded.opted_out, source = excluded.source, updated_at = now();

  update public.leads
     set sms_opted_out    = p_opted_out,
         sms_opted_out_at = case when p_opted_out then now() else null end
   where public.norm_au_phone(phone) = v_phone
     and sms_opted_out is distinct from p_opted_out;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.suppression_add(p_kind text, p_value text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  perform public.contact_suppress(p_kind, p_value, 'manual', 'dashboard', p_note);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.suppression_list(p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, kind text, value text, reason text, source text, note text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.jarvis_assert_operator();
  return query
    select s.id, s.kind, s.value, s.reason, s.source, s.note, s.created_at
      from public.contact_suppressions s
     order by s.created_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 1000);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_order_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- When a lead is inserted for an order, increment leads_delivered
  UPDATE pilot_orders
  SET
    leads_delivered = leads_delivered + 1,
    status = CASE
      WHEN leads_delivered + 1 >= lead_count THEN 'complete'
      WHEN leads_delivered + 1 > 0 THEN 'delivering'
      ELSE status
    END
  WHERE id = NEW.order_id;
  RETURN NEW;
END;
$function$
;


-- ===== Views =====
create view public.buyer_dispute_rates as
 SELECT pl.buyer_email,
    count(pl.id) AS total_leads,
    count(ld.id) AS disputed_leads,
    round((((count(ld.id))::numeric / (NULLIF(count(pl.id), 0))::numeric) * (100)::numeric), 1) AS dispute_rate_pct
   FROM (pilot_leads pl
     LEFT JOIN lead_disputes ld ON (((ld.lead_id = pl.id) AND (ld.status <> 'resolved'::text))))
  GROUP BY pl.buyer_email;

create view public.fulfilment_stuck with (security_invoker=true) as
 SELECT id AS client_id,
    company_name,
    stage,
    onboarding_sub_stage,
    ql_hq_company_id,
    fulfilment_next_step,
    fulfilment_next_due,
    fulfilment_blocked_count,
    fulfilment_steps_settled,
    fulfilment_steps_total,
    fulfilment_stage_at,
    (GREATEST((0)::numeric, (EXTRACT(epoch FROM (now() - fulfilment_next_due)) / (3600)::numeric)))::integer AS hours_overdue
   FROM clients c
  WHERE ((NOT is_sales_rep()) AND (fulfilment_next_step IS NOT NULL) AND (((fulfilment_next_due IS NOT NULL) AND (fulfilment_next_due < now())) OR (COALESCE(fulfilment_blocked_count, 0) > 0)));


-- ===== Foreign keys =====
alter table public.ad_spend_daily add constraint ad_spend_daily_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.campaign_spend_log add constraint campaign_spend_log_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES meta_campaigns(id) ON DELETE SET NULL;
alter table public.client_action_log add constraint client_action_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table public.flagged_emails add constraint flagged_emails_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.invoices add constraint invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
alter table public.jarvis_threads add constraint jarvis_threads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.lead_contact_log add constraint lead_contact_log_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
alter table public.lead_delivery_log add constraint lead_delivery_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.lead_delivery_log add constraint lead_delivery_log_ppl_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ppl_leads(id) ON DELETE CASCADE;
alter table public.lead_disputes add constraint lead_disputes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES pilot_leads(id) ON DELETE CASCADE;
alter table public.lead_disputes add constraint lead_disputes_replacement_lead_id_fkey FOREIGN KEY (replacement_lead_id) REFERENCES pilot_leads(id);
alter table public.lead_sms_log add constraint lead_sms_log_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ppl_leads(id) ON DELETE CASCADE;
alter table public.leads add constraint leads_assigned_client_id_fkey FOREIGN KEY (assigned_client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.leads add constraint leads_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.leads_daily add constraint leads_daily_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table public.managed_alerts add constraint managed_alerts_managed_campaign_id_fkey FOREIGN KEY (managed_campaign_id) REFERENCES managed_campaigns(id) ON DELETE CASCADE;
alter table public.managed_campaigns add constraint managed_campaigns_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.managed_launch_log add constraint managed_launch_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.managed_launch_log add constraint managed_launch_log_managed_campaign_id_fkey FOREIGN KEY (managed_campaign_id) REFERENCES managed_campaigns(id) ON DELETE SET NULL;
alter table public.managed_order_log add constraint managed_order_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table public.meta_capi_events add constraint meta_capi_events_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
alter table public.outreach_queries add constraint outreach_queries_niche_key_fkey FOREIGN KEY (niche_key) REFERENCES outreach_niches(key);
alter table public.pilot_leads add constraint pilot_leads_order_id_fkey FOREIGN KEY (order_id) REFERENCES pilot_orders(id) ON DELETE SET NULL;
alter table public.pilot_orders add constraint pilot_orders_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
alter table public.ppl_campaign_action_log add constraint ppl_campaign_action_log_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES ppl_campaigns(id) ON DELETE CASCADE;
alter table public.ppl_campaigns add constraint ppl_campaigns_meta_campaign_id_fkey FOREIGN KEY (meta_campaign_id) REFERENCES meta_campaigns(id) ON DELETE SET NULL;
alter table public.ppl_lead_areas add constraint ppl_lead_areas_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table public.ppl_leads add constraint solar_leads_assigned_client_id_fkey FOREIGN KEY (assigned_client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.ppl_order_log add constraint ppl_order_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table public.prospects add constraint prospects_niche_key_fkey FOREIGN KEY (niche_key) REFERENCES outreach_niches(key);
alter table public.revenue add constraint revenue_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.sales_email_log add constraint sales_email_log_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
alter table public.sales_rep_config add constraint sales_rep_config_auto_assign_rep_id_fkey FOREIGN KEY (auto_assign_rep_id) REFERENCES sales_reps(user_id) ON DELETE SET NULL;
alter table public.sales_sms_log add constraint sales_sms_log_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE;
alter table public.webhook_delivery_log add constraint webhook_delivery_log_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES pilot_leads(id);
alter table public.webhook_delivery_log add constraint webhook_delivery_log_order_id_fkey FOREIGN KEY (order_id) REFERENCES pilot_orders(id);

-- ===== Indexes =====
CREATE INDEX buyer_flags_email_idx ON public.buyer_flags USING btree (buyer_email);
CREATE UNIQUE INDEX campaign_spend_log_sync_uniq ON public.campaign_spend_log USING btree (campaign_id, period) WHERE (source = 'sync'::text);
CREATE INDEX client_action_log_client_id_idx ON public.client_action_log USING btree (client_id);
CREATE INDEX clients_email_domain_idx ON public.clients USING btree (email_domain(email));
CREATE INDEX clients_email_norm_idx ON public.clients USING btree (norm_email(email));
CREATE INDEX clients_fulfilment_next_due_idx ON public.clients USING btree (fulfilment_next_due) WHERE (fulfilment_next_due IS NOT NULL);
CREATE INDEX clients_phone_norm_idx ON public.clients USING btree (norm_au_phone(phone));
CREATE INDEX clients_ql_hq_company_id_idx ON public.clients USING btree (ql_hq_company_id) WHERE (ql_hq_company_id IS NOT NULL);
CREATE INDEX hiring_candidates_followup_idx ON public.hiring_candidates USING btree (next_followup) WHERE (next_followup IS NOT NULL);
CREATE INDEX hiring_candidates_stage_idx ON public.hiring_candidates USING btree (stage);
CREATE INDEX idx_ad_spend_client ON public.ad_spend_daily USING btree (client_id, date DESC);
CREATE INDEX idx_ad_spend_daily_date ON public.ad_spend_daily USING btree (date DESC, account_type);
CREATE INDEX idx_clients_type ON public.clients USING btree (type);
CREATE INDEX idx_clients_type_stage ON public.clients USING btree (type, stage);
CREATE INDEX idx_customer_settings_email ON public.customer_settings USING btree (customer_email);
CREATE INDEX idx_daily_snapshots_date ON public.daily_snapshots USING btree (snapshot_date);
CREATE INDEX idx_expenses_date ON public.expenses USING btree (date DESC);
CREATE INDEX idx_flagged_emails_status ON public.flagged_emails USING btree (status, created_at DESC);
CREATE INDEX idx_lead_sms_log_lead_direction ON public.lead_sms_log USING btree (lead_id, direction, created_at DESC);
CREATE INDEX idx_leads_daily_client_date ON public.leads_daily USING btree (client_id, date DESC);
CREATE INDEX idx_leads_daily_date ON public.leads_daily USING btree (date DESC);
CREATE INDEX idx_leads_sms_opted_out ON public.leads USING btree (sms_opted_out) WHERE sms_opted_out;
CREATE INDEX idx_revenue_date ON public.revenue USING btree (date DESC);
CREATE INDEX idx_sales_sms_log_lead_direction ON public.sales_sms_log USING btree (lead_id, direction, created_at DESC);
CREATE INDEX invoices_owner_id_idx ON public.invoices USING btree (owner_id);
CREATE INDEX jarvis_events_open_idx ON public.jarvis_events USING btree (kind) WHERE (resolved_at IS NULL);
CREATE INDEX jarvis_events_pending_idx ON public.jarvis_events USING btree (tier, first_seen_at) WHERE ((notified_at IS NULL) AND (resolved_at IS NULL));
CREATE INDEX jarvis_events_phone_pending_idx ON public.jarvis_events USING btree (first_seen_at) WHERE ((phone_handled_at IS NULL) AND (resolved_at IS NULL));
CREATE INDEX jarvis_jobs_due_idx ON public.jarvis_jobs USING btree (next_run_at) WHERE active;
CREATE INDEX jarvis_memory_created_idx ON public.jarvis_memory USING btree (created_at DESC);
CREATE INDEX jarvis_messages_created_idx ON public.jarvis_messages USING btree (created_at DESC);
CREATE INDEX jarvis_notifications_created_idx ON public.jarvis_notifications USING btree (created_at DESC);
CREATE INDEX jarvis_notifications_unread_idx ON public.jarvis_notifications USING btree (created_at DESC) WHERE ((channel = 'panel'::text) AND (read_at IS NULL));
CREATE INDEX jarvis_outbox_campaign_idx ON public.jarvis_outbox USING btree (campaign_id);
CREATE INDEX jarvis_outbox_lead_idx ON public.jarvis_outbox USING btree (lead_id, created_at DESC);
CREATE INDEX jarvis_outbox_queue_idx ON public.jarvis_outbox USING btree (status, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'sending'::text]));
CREATE INDEX jarvis_posts_created_idx ON public.jarvis_posts USING btree (created_at DESC);
CREATE INDEX jarvis_usage_created_idx ON public.jarvis_usage USING btree (created_at DESC);
CREATE INDEX lead_contact_log_lead_id_idx ON public.lead_contact_log USING btree (lead_id);
CREATE INDEX lead_disputes_buyer_email_idx ON public.lead_disputes USING btree (buyer_email);
CREATE INDEX lead_disputes_lead_id_idx ON public.lead_disputes USING btree (lead_id);
CREATE INDEX lead_disputes_status_idx ON public.lead_disputes USING btree (status);
CREATE INDEX leads_assigned_client_status_idx ON public.leads USING btree (assigned_client_id, status);
CREATE INDEX leads_email_domain_idx ON public.leads USING btree (email_domain(email));
CREATE INDEX leads_email_lower_idx ON public.leads USING btree (lower(email)) WHERE (email IS NOT NULL);
CREATE INDEX leads_email_norm_idx ON public.leads USING btree (norm_email(email));
CREATE INDEX leads_hq_company_idx ON public.leads USING btree (hq_company_id) WHERE (hq_company_id IS NOT NULL);
CREATE INDEX leads_next_followup_idx ON public.leads USING btree (next_followup);
CREATE INDEX leads_owner_id_idx ON public.leads USING btree (owner_id);
CREATE INDEX leads_phone_digits9_idx ON public.leads USING btree (phone_digits9(phone)) WHERE (phone IS NOT NULL);
CREATE INDEX leads_phone_norm_idx ON public.leads USING btree (norm_au_phone(phone));
CREATE INDEX leads_status_idx ON public.leads USING btree (status);
CREATE INDEX managed_campaigns_client ON public.managed_campaigns USING btree (client_id);
CREATE INDEX meta_capi_events_unsent ON public.meta_capi_events USING btree (created_at) WHERE (sent_at IS NULL);
CREATE INDEX outreach_events_prospect_idx ON public.outreach_events USING btree (prospect_id, received_at DESC);
CREATE INDEX outreach_events_received_idx ON public.outreach_events USING btree (received_at DESC);
CREATE INDEX outreach_runs_started_idx ON public.outreach_runs USING btree (started_at DESC);
CREATE INDEX outreach_sent_recipient_idx ON public.outreach_sent USING btree (recipient, claimed_at DESC);
CREATE INDEX pcal_campaign_id_idx ON public.ppl_campaign_action_log USING btree (campaign_id);
CREATE INDEX pilot_leads_buyer_email_idx ON public.pilot_leads USING btree (buyer_email);
CREATE INDEX pilot_leads_created_at_idx ON public.pilot_leads USING btree (created_at DESC);
CREATE INDEX pilot_leads_order_id_idx ON public.pilot_leads USING btree (order_id);
CREATE INDEX pilot_orders_created_at_idx ON public.pilot_orders USING btree (created_at DESC);
CREATE INDEX pilot_orders_email_idx ON public.pilot_orders USING btree (email);
CREATE INDEX pilot_orders_payment_status_idx ON public.pilot_orders USING btree (payment_status);
CREATE INDEX ppl_campaigns_status_idx ON public.ppl_campaigns USING btree (status);
CREATE INDEX ppl_leads_assigned_client_status_idx ON public.ppl_leads USING btree (assigned_client_id, status);
CREATE INDEX ppl_leads_created_at_idx ON public.ppl_leads USING btree (created_at DESC);
CREATE INDEX ppl_leads_lead_type_idx ON public.ppl_leads USING btree (lead_type);
CREATE INDEX ppl_leads_status_idx ON public.ppl_leads USING btree (status);
CREATE UNIQUE INDEX prospects_abn_uq ON public.prospects USING btree (abn) WHERE (abn IS NOT NULL);
CREATE UNIQUE INDEX prospects_domain_uq ON public.prospects USING btree (domain) WHERE (domain IS NOT NULL);
CREATE UNIQUE INDEX prospects_email_uq ON public.prospects USING btree (email) WHERE (email IS NOT NULL);
CREATE INDEX prospects_phone_idx ON public.prospects USING btree (phone) WHERE (phone IS NOT NULL);
CREATE UNIQUE INDEX prospects_place_uq ON public.prospects USING btree (google_place_id) WHERE (google_place_id IS NOT NULL);
CREATE INDEX prospects_status_idx ON public.prospects USING btree (niche_key, status);
CREATE INDEX sales_email_log_lead_idx ON public.sales_email_log USING btree (lead_id, sent_at DESC);
CREATE INDEX sales_sms_log_created_at_idx ON public.sales_sms_log USING btree (created_at DESC);
CREATE INDEX sales_sms_log_lead_id_idx ON public.sales_sms_log USING btree (lead_id);

-- ===== Triggers =====
CREATE TRIGGER buyer_flags_updated_at BEFORE UPDATE ON public.buyer_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER managed_active_default_ads_live BEFORE INSERT OR UPDATE OF stage, active_status, type ON public.clients FOR EACH ROW EXECUTE FUNCTION managed_active_default_ads_live();
CREATE TRIGGER contact_suppressions_after_insert AFTER INSERT ON public.contact_suppressions FOR EACH ROW EXECUTE FUNCTION contact_suppressions_after_insert();
CREATE TRIGGER trg_invoice_number BEFORE INSERT ON public.invoices FOR EACH ROW WHEN ((new.invoice_number IS NULL)) EXECUTE FUNCTION generate_invoice_number();
CREATE TRIGGER trg_set_invoice_number BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION set_invoice_number();
CREATE TRIGGER trg_set_invoice_owner BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION set_invoice_owner();
CREATE TRIGGER lead_disputes_updated_at BEFORE UPDATE ON public.lead_disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER leads_stamp_stage_change BEFORE INSERT OR UPDATE OF stage ON public.leads FOR EACH ROW EXECUTE FUNCTION leads_stamp_stage_change();
CREATE TRIGGER trg_auto_assign_lead BEFORE INSERT ON public.leads FOR EACH ROW EXECUTE FUNCTION auto_assign_lead();
CREATE TRIGGER trg_send_meta_conversion AFTER UPDATE OF stage ON public.leads FOR EACH ROW EXECUTE FUNCTION send_meta_conversion();
CREATE TRIGGER trg_lead_delivered AFTER INSERT ON public.pilot_leads FOR EACH ROW WHEN ((new.order_id IS NOT NULL)) EXECUTE FUNCTION update_order_status();
CREATE TRIGGER prospects_before_write BEFORE INSERT OR UPDATE ON public.prospects FOR EACH ROW EXECUTE FUNCTION prospects_before_write();

-- ===== Row level security policies =====
create policy "Authenticated users only" on public.ad_spend_daily as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy auth_all_ad_spend_daily on public.ad_spend_daily as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Authenticated manage agent_files" on public.agent_files as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Authenticated users only" on public.agent_files as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy "Service role agent_files" on public.agent_files as permissive for all to service_role
  using (true)
  with check (true);

create policy auth_all_agent_files on public.agent_files as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Authenticated users can insert business_settings" on public.business_settings as permissive for insert to authenticated
  with check (true);

create policy "Authenticated users can read business_settings" on public.business_settings as permissive for select to authenticated
  using (true);

create policy "Authenticated users can update business_settings" on public.business_settings as permissive for update to authenticated
  using (true)
  with check (true);

create policy "Buyers read own buyer_flags" on public.buyer_flags as permissive for select to authenticated
  using ((buyer_email = (auth.jwt() ->> 'email'::text)));

create policy "Authenticated users manage spend log" on public.campaign_spend_log as permissive for all to authenticated
  using (true)
  with check (true);

create policy no_sales_rep_money on public.campaign_spend_log as restrictive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy "Allow all for authenticated" on public.client_action_log as permissive for all to public
  using ((auth.role() = 'authenticated'::text));

create policy "Authenticated users only" on public.clients as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy auth_all_clients on public.clients as permissive for all to authenticated
  using (true)
  with check (true);

create policy clients_full_users_read on public.clients as permissive for select to authenticated
  using ((NOT is_sales_rep()));

create policy no_sales_rep_money on public.clients as restrictive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy customer_settings_insert on public.customer_settings as permissive for insert to public
  with check ((customer_email = (auth.jwt() ->> 'email'::text)));

create policy customer_settings_select on public.customer_settings as permissive for select to public
  using ((customer_email = (auth.jwt() ->> 'email'::text)));

create policy customer_settings_update on public.customer_settings as permissive for update to public
  using ((customer_email = (auth.jwt() ->> 'email'::text)));

create policy "Authenticated users can manage daily_notes" on public.daily_notes as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Service role full access to daily_notes" on public.daily_notes as permissive for all to service_role
  using (true)
  with check (true);

create policy "Allow authenticated read" on public.daily_snapshots as permissive for select to authenticated
  using (true);

create policy auth_read_daily_snapshots on public.daily_snapshots as permissive for select to authenticated
  using (true);

create policy authenticated_all on public.delivery_configs as permissive for all to authenticated
  using (true)
  with check (true);

create policy dismissed_alerts_full_users on public.dismissed_alerts as permissive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy "Authenticated users only" on public.expenses as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy auth_all_expenses on public.expenses as permissive for all to authenticated
  using (true)
  with check (true);

create policy no_sales_rep_money on public.expenses as restrictive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy "Authenticated users only" on public.flagged_emails as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy auth_all_flagged_emails on public.flagged_emails as permissive for all to authenticated
  using (true)
  with check (true);

create policy hiring_candidates_delete on public.hiring_candidates as permissive for delete to authenticated
  using ((NOT is_sales_rep()));

create policy hiring_candidates_insert on public.hiring_candidates as permissive for insert to authenticated
  with check ((NOT is_sales_rep()));

create policy hiring_candidates_select on public.hiring_candidates as permissive for select to authenticated
  using ((NOT is_sales_rep()));

create policy hiring_candidates_update on public.hiring_candidates as permissive for update to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy invoices_delete on public.invoices as permissive for delete to authenticated
  using (((NOT is_sales_rep()) OR (owner_id = auth.uid())));

create policy invoices_insert on public.invoices as permissive for insert to authenticated
  with check (((NOT is_sales_rep()) OR (owner_id = auth.uid())));

create policy invoices_select on public.invoices as permissive for select to authenticated
  using (((NOT is_sales_rep()) OR (owner_id = auth.uid())));

create policy invoices_update on public.invoices as permissive for update to authenticated
  using (((NOT is_sales_rep()) OR (owner_id = auth.uid())))
  with check (((NOT is_sales_rep()) OR (owner_id = auth.uid())));

create policy lcl_delete on public.lead_contact_log as permissive for delete to authenticated
  using ((NOT is_sales_rep()));

create policy lcl_insert on public.lead_contact_log as permissive for insert to authenticated
  with check (((NOT is_sales_rep()) OR (lead_id IN ( SELECT leads.id
   FROM leads
  WHERE (leads.owner_id = auth.uid())))));

create policy lcl_select on public.lead_contact_log as permissive for select to authenticated
  using (((NOT is_sales_rep()) OR (lead_id IN ( SELECT leads.id
   FROM leads
  WHERE (leads.owner_id = auth.uid())))));

create policy lcl_update on public.lead_contact_log as permissive for update to authenticated
  using (((NOT is_sales_rep()) OR (lead_id IN ( SELECT leads.id
   FROM leads
  WHERE (leads.owner_id = auth.uid())))));

create policy admin_all on public.lead_delivery_log as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Buyers can insert lead_disputes" on public.lead_disputes as permissive for insert to authenticated
  with check ((buyer_email = (auth.jwt() ->> 'email'::text)));

create policy "Buyers read own lead_disputes" on public.lead_disputes as permissive for select to authenticated
  using ((buyer_email = (auth.jwt() ->> 'email'::text)));

create policy "Users manage own disputes" on public.lead_disputes as permissive for all to public
  using ((buyer_email = (auth.jwt() ->> 'email'::text)));

create policy "Authenticated users full access" on public.lead_pricing_areas as permissive for all to public
  using ((auth.role() = 'authenticated'::text));

create policy admin_all on public.lead_sms_log as permissive for all to authenticated
  using (true)
  with check (true);

create policy leads_delete on public.leads as permissive for delete to authenticated
  using ((NOT is_sales_rep()));

create policy leads_insert on public.leads as permissive for insert to authenticated
  with check ((NOT is_sales_rep()));

create policy leads_select on public.leads as permissive for select to authenticated
  using (((NOT is_sales_rep()) OR (owner_id = auth.uid())));

create policy leads_update on public.leads as permissive for update to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy "Authenticated users only" on public.leads_daily as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy "Authenticated users can read managed_alerts" on public.managed_alerts as permissive for select to authenticated
  using (true);

create policy "Service role full access to managed_alerts" on public.managed_alerts as permissive for all to service_role
  using (true)
  with check (true);

create policy "Authenticated users can read managed_campaigns" on public.managed_campaigns as permissive for select to authenticated
  using (true);

create policy "Service role full access to managed_campaigns" on public.managed_campaigns as permissive for all to service_role
  using (true)
  with check (true);

create policy "Authenticated users can read managed_launch_log" on public.managed_launch_log as permissive for select to authenticated
  using (true);

create policy "Service role full access to managed_launch_log" on public.managed_launch_log as permissive for all to service_role
  using (true)
  with check (true);

create policy "Authenticated users can manage managed_order_log" on public.managed_order_log as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Service role full access to managed_order_log" on public.managed_order_log as permissive for all to service_role
  using (true)
  with check (true);

create policy no_sales_rep_money on public.managed_order_log as restrictive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy "Authenticated users can manage meta_ad_accounts" on public.meta_ad_accounts as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Service role full access to meta_ad_accounts" on public.meta_ad_accounts as permissive for all to service_role
  using (true)
  with check (true);

create policy "Authenticated users can insert meta_api_log" on public.meta_api_log as permissive for insert to authenticated
  with check (true);

create policy "Authenticated users can read meta_api_log" on public.meta_api_log as permissive for select to authenticated
  using (true);

create policy "Service role full access to meta_api_log" on public.meta_api_log as permissive for all to service_role
  using (true)
  with check (true);

create policy "Authenticated users can manage meta_campaigns" on public.meta_campaigns as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Service role full access to meta_campaigns" on public.meta_campaigns as permissive for all to service_role
  using (true)
  with check (true);

create policy "Service role full access to meta_capi_events" on public.meta_capi_events as permissive for all to service_role
  using (true)
  with check (true);

create policy "Team can read meta_capi_events" on public.meta_capi_events as permissive for select to authenticated
  using ((NOT is_sales_rep()));

create policy "Authenticated users can manage monthly_goals" on public.monthly_goals as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Service role full access to monthly_goals" on public.monthly_goals as permissive for all to service_role
  using (true)
  with check (true);

create policy no_sales_rep_money on public.monthly_goals as restrictive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy pay_rates_full_users on public.pay_rates as permissive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy admin_all on public.pending_orders as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Buyers read own pilot_leads" on public.pilot_leads as permissive for select to authenticated
  using ((buyer_email = (auth.jwt() ->> 'email'::text)));

create policy "Buyers read own pilot_orders" on public.pilot_orders as permissive for select to authenticated
  using ((email = (auth.jwt() ->> 'email'::text)));

create policy "Users see own orders" on public.pilot_orders as permissive for select to public
  using ((email = (auth.jwt() ->> 'email'::text)));

create policy pcal_auth_all on public.ppl_campaign_action_log as permissive for all to public
  using ((auth.role() = 'authenticated'::text));

create policy ppl_campaigns_auth_all on public.ppl_campaigns as permissive for all to public
  using ((auth.role() = 'authenticated'::text));

create policy auth_all_ppl_lead_areas on public.ppl_lead_areas as permissive for all to authenticated
  using (true)
  with check (true);

create policy admin_all on public.ppl_leads as permissive for all to authenticated
  using (true)
  with check (true);

create policy auth_all_solar_leads on public.ppl_leads as permissive for all to authenticated
  using (true)
  with check (true);

create policy auth_all_ppl_order_log on public.ppl_order_log as permissive for all to authenticated
  using (true)
  with check (true);

create policy no_sales_rep_money on public.ppl_order_log as restrictive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy "Authenticated users only" on public.revenue as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy auth_all_revenue on public.revenue as permissive for all to authenticated
  using (true)
  with check (true);

create policy no_sales_rep_money on public.revenue as restrictive for all to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy sales_email_log_select on public.sales_email_log as permissive for select to authenticated
  using (((NOT is_sales_rep()) OR (EXISTS ( SELECT 1
   FROM leads l
  WHERE ((l.id = sales_email_log.lead_id) AND (l.owner_id = auth.uid()))))));

create policy sales_email_templates_select on public.sales_email_templates as permissive for select to authenticated
  using (true);

create policy sales_email_templates_write on public.sales_email_templates as permissive for update to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy sales_reps_select_self on public.sales_reps as permissive for select to authenticated
  using ((user_id = auth.uid()));

create policy ssl_delete on public.sales_sms_log as permissive for delete to authenticated
  using ((NOT is_sales_rep()));

create policy ssl_insert on public.sales_sms_log as permissive for insert to authenticated
  with check ((NOT is_sales_rep()));

create policy ssl_select on public.sales_sms_log as permissive for select to authenticated
  using (((NOT is_sales_rep()) OR (lead_id IN ( SELECT leads.id
   FROM leads
  WHERE (leads.owner_id = auth.uid())))));

create policy ssl_update on public.sales_sms_log as permissive for update to authenticated
  using ((NOT is_sales_rep()))
  with check ((NOT is_sales_rep()));

create policy "Authenticated users only" on public.subscriptions as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy auth_all_subscriptions on public.subscriptions as permissive for all to authenticated
  using (true)
  with check (true);

create policy "Auth users full access to tasks" on public.tasks as permissive for all to public
  using ((auth.role() = 'authenticated'::text))
  with check ((auth.role() = 'authenticated'::text));

create policy "Authenticated users only" on public.tasks as permissive for all to public
  using ((auth.uid() IS NOT NULL));

create policy auth_all_tasks on public.tasks as permissive for all to authenticated
  using (true)
  with check (true);

create policy webhook_log_select on public.webhook_delivery_log as permissive for select to public
  using ((customer_email = (auth.jwt() ->> 'email'::text)));


-- ===== Privileges =====
revoke all on table public.ad_spend_daily from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ad_spend_daily to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ad_spend_daily to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ad_spend_daily to service_role;
revoke all on function public.add_lead(p_name text, p_company text, p_email text, p_phone text, p_stage text, p_lead_type text, p_value numeric, p_source text, p_notes text) from public, anon, authenticated, service_role;
grant execute on function public.add_lead(p_name text, p_company text, p_email text, p_phone text, p_stage text, p_lead_type text, p_value numeric, p_source text, p_notes text) to authenticated;
grant execute on function public.add_lead(p_name text, p_company text, p_email text, p_phone text, p_stage text, p_lead_type text, p_value numeric, p_source text, p_notes text) to service_role;
revoke all on table public.agent_files from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.agent_files to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.agent_files to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.agent_files to service_role;
revoke all on table public.app_settings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.app_settings to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.app_settings to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.app_settings to service_role;
revoke all on function public.assign_solar_lead(p_lead_id uuid, p_postcode text) from public, anon, authenticated, service_role;
grant execute on function public.assign_solar_lead(p_lead_id uuid, p_postcode text) to authenticated;
grant execute on function public.assign_solar_lead(p_lead_id uuid, p_postcode text) to service_role;
revoke all on function public.auto_assign_lead() from public, anon, authenticated, service_role;
grant execute on function public.auto_assign_lead() to anon;
grant execute on function public.auto_assign_lead() to authenticated;
grant execute on function public.auto_assign_lead() to public;
grant execute on function public.auto_assign_lead() to service_role;
revoke all on function public.business_domain(p_website text, p_email text) from public, anon, authenticated, service_role;
grant execute on function public.business_domain(p_website text, p_email text) to anon;
grant execute on function public.business_domain(p_website text, p_email text) to authenticated;
grant execute on function public.business_domain(p_website text, p_email text) to public;
grant execute on function public.business_domain(p_website text, p_email text) to service_role;
revoke all on table public.business_settings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.business_settings to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.business_settings to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.business_settings to service_role;
revoke all on table public.buyer_dispute_rates from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.buyer_dispute_rates to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.buyer_dispute_rates to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.buyer_dispute_rates to service_role;
revoke all on table public.buyer_flags from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.buyer_flags to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.buyer_flags to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.buyer_flags to service_role;
revoke all on table public.campaign_spend_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.campaign_spend_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.campaign_spend_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.campaign_spend_log to service_role;
revoke all on table public.client_action_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.client_action_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.client_action_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.client_action_log to service_role;
revoke all on table public.clients from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.clients to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.clients to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.clients to service_role;
revoke all on function public.contact_is_suppressed(p_email text, p_phone text) from public, anon, authenticated, service_role;
grant execute on function public.contact_is_suppressed(p_email text, p_phone text) to service_role;
revoke all on function public.contact_suppress(p_kind text, p_value text, p_reason text, p_source text, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.contact_suppress(p_kind text, p_value text, p_reason text, p_source text, p_note text) to service_role;
revoke all on function public.contact_suppressions_after_insert() from public, anon, authenticated, service_role;
grant execute on function public.contact_suppressions_after_insert() to anon;
grant execute on function public.contact_suppressions_after_insert() to authenticated;
grant execute on function public.contact_suppressions_after_insert() to public;
grant execute on function public.contact_suppressions_after_insert() to service_role;
revoke all on table public.contact_suppressions from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.contact_suppressions to service_role;
revoke all on table public.customer_settings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.customer_settings to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.customer_settings to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.customer_settings to service_role;
revoke all on table public.daily_notes from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_notes to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_notes to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_notes to service_role;
revoke all on table public.daily_snapshots from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_snapshots to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_snapshots to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.daily_snapshots to service_role;
revoke all on table public.delivery_configs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_configs to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_configs to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.delivery_configs to service_role;
revoke all on table public.dismissed_alerts from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.dismissed_alerts to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.dismissed_alerts to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.dismissed_alerts to service_role;
revoke all on function public.email_domain(p text) from public, anon, authenticated, service_role;
grant execute on function public.email_domain(p text) to anon;
grant execute on function public.email_domain(p text) to authenticated;
grant execute on function public.email_domain(p text) to public;
grant execute on function public.email_domain(p text) to service_role;
revoke all on table public.expenses from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.expenses to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.expenses to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.expenses to service_role;
revoke all on function public.find_leads_by_contact(p_email text, p_phone text, p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.find_leads_by_contact(p_email text, p_phone text, p_limit integer) to service_role;
revoke all on table public.flagged_emails from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.flagged_emails to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.flagged_emails to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.flagged_emails to service_role;
revoke all on table public.fulfilment_stuck from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.fulfilment_stuck to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.fulfilment_stuck to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.fulfilment_stuck to service_role;
revoke all on function public.generate_invoice_number() from public, anon, authenticated, service_role;
grant execute on function public.generate_invoice_number() to anon;
grant execute on function public.generate_invoice_number() to authenticated;
grant execute on function public.generate_invoice_number() to public;
grant execute on function public.generate_invoice_number() to service_role;
revoke all on function public.get_meta_capi_token() from public, anon, authenticated, service_role;
grant execute on function public.get_meta_capi_token() to service_role;
revoke all on table public.hiring_candidates from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.hiring_candidates to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.hiring_candidates to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.hiring_candidates to service_role;
revoke all on function public.increment_leads_delivered(p_client_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.increment_leads_delivered(p_client_id uuid) to authenticated;
grant execute on function public.increment_leads_delivered(p_client_id uuid) to service_role;
revoke all on sequence public.invoice_number_seq from public, anon, authenticated, service_role;
grant SELECT, UPDATE, USAGE on sequence public.invoice_number_seq to anon;
grant SELECT, UPDATE, USAGE on sequence public.invoice_number_seq to authenticated;
grant SELECT, UPDATE, USAGE on sequence public.invoice_number_seq to service_role;
revoke all on table public.invoices from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.invoices to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.invoices to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.invoices to service_role;
revoke all on function public.is_free_mail_domain(p text) from public, anon, authenticated, service_role;
grant execute on function public.is_free_mail_domain(p text) to anon;
grant execute on function public.is_free_mail_domain(p text) to authenticated;
grant execute on function public.is_free_mail_domain(p text) to public;
grant execute on function public.is_free_mail_domain(p text) to service_role;
revoke all on function public.is_sales_rep() from public, anon, authenticated, service_role;
grant execute on function public.is_sales_rep() to anon;
grant execute on function public.is_sales_rep() to authenticated;
grant execute on function public.is_sales_rep() to public;
grant execute on function public.is_sales_rep() to service_role;
revoke all on function public.jarvis_action_log(p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_action_log(p_limit integer) to authenticated;
grant execute on function public.jarvis_action_log(p_limit integer) to service_role;
revoke all on function public.jarvis_apply_scan() from public, anon, authenticated, service_role;
grant execute on function public.jarvis_apply_scan() to service_role;
revoke all on function public.jarvis_assert_operator() from public, anon, authenticated, service_role;
grant execute on function public.jarvis_assert_operator() to anon;
grant execute on function public.jarvis_assert_operator() to authenticated;
grant execute on function public.jarvis_assert_operator() to public;
grant execute on function public.jarvis_assert_operator() to service_role;
revoke all on function public.jarvis_claim_due_jobs(p_limit integer, p_tz text) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_claim_due_jobs(p_limit integer, p_tz text) to service_role;
revoke all on table public.jarvis_events from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_events to service_role;
revoke all on function public.jarvis_inbox(p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_inbox(p_limit integer) to authenticated;
grant execute on function public.jarvis_inbox(p_limit integer) to service_role;
revoke all on function public.jarvis_inbox_read(p_ids uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_inbox_read(p_ids uuid[]) to authenticated;
grant execute on function public.jarvis_inbox_read(p_ids uuid[]) to service_role;
revoke all on function public.jarvis_job_cancel(p_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_job_cancel(p_id uuid) to authenticated;
grant execute on function public.jarvis_job_cancel(p_id uuid) to service_role;
revoke all on function public.jarvis_job_list() from public, anon, authenticated, service_role;
grant execute on function public.jarvis_job_list() to authenticated;
grant execute on function public.jarvis_job_list() to service_role;
revoke all on function public.jarvis_job_next(p_repeat text, p_from timestamp with time zone, p_tz text) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_job_next(p_repeat text, p_from timestamp with time zone, p_tz text) to anon;
grant execute on function public.jarvis_job_next(p_repeat text, p_from timestamp with time zone, p_tz text) to authenticated;
grant execute on function public.jarvis_job_next(p_repeat text, p_from timestamp with time zone, p_tz text) to public;
grant execute on function public.jarvis_job_next(p_repeat text, p_from timestamp with time zone, p_tz text) to service_role;
revoke all on function public.jarvis_job_next_future(p_repeat text, p_from timestamp with time zone, p_tz text) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_job_next_future(p_repeat text, p_from timestamp with time zone, p_tz text) to anon;
grant execute on function public.jarvis_job_next_future(p_repeat text, p_from timestamp with time zone, p_tz text) to authenticated;
grant execute on function public.jarvis_job_next_future(p_repeat text, p_from timestamp with time zone, p_tz text) to public;
grant execute on function public.jarvis_job_next_future(p_repeat text, p_from timestamp with time zone, p_tz text) to service_role;
revoke all on table public.jarvis_jobs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_jobs to service_role;
revoke all on function public.jarvis_memory_delete(p_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_memory_delete(p_id uuid) to authenticated;
grant execute on function public.jarvis_memory_delete(p_id uuid) to service_role;
revoke all on function public.jarvis_memory_list() from public, anon, authenticated, service_role;
grant execute on function public.jarvis_memory_list() to authenticated;
grant execute on function public.jarvis_memory_list() to service_role;
revoke all on function public.jarvis_memory_save(p_id uuid, p_content text) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_memory_save(p_id uuid, p_content text) to authenticated;
grant execute on function public.jarvis_memory_save(p_id uuid, p_content text) to service_role;
revoke all on table public.jarvis_memory from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_memory to service_role;
revoke all on table public.jarvis_messages from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_messages to service_role;
revoke all on table public.jarvis_notifications from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_notifications to service_role;
revoke all on function public.jarvis_outbox_claim(p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_outbox_claim(p_limit integer) to service_role;
revoke all on table public.jarvis_outbox from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_outbox to service_role;
revoke all on function public.jarvis_post_approve(p_id uuid, p_caption text) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_post_approve(p_id uuid, p_caption text) to authenticated;
grant execute on function public.jarvis_post_approve(p_id uuid, p_caption text) to service_role;
revoke all on function public.jarvis_post_list(p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_post_list(p_limit integer) to authenticated;
grant execute on function public.jarvis_post_list(p_limit integer) to service_role;
revoke all on function public.jarvis_post_set_status(p_id uuid, p_status text) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_post_set_status(p_id uuid, p_status text) to authenticated;
grant execute on function public.jarvis_post_set_status(p_id uuid, p_status text) to service_role;
revoke all on table public.jarvis_posts from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_posts to service_role;
revoke all on function public.jarvis_scan() from public, anon, authenticated, service_role;
grant execute on function public.jarvis_scan() to service_role;
revoke all on function public.jarvis_scan_base() from public, anon, authenticated, service_role;
grant execute on function public.jarvis_scan_base() to service_role;
revoke all on function public.jarvis_status() from public, anon, authenticated, service_role;
grant execute on function public.jarvis_status() to authenticated;
grant execute on function public.jarvis_status() to service_role;
revoke all on table public.jarvis_threads from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_threads to service_role;
revoke all on function public.jarvis_usage_summary(p_tz text) from public, anon, authenticated, service_role;
grant execute on function public.jarvis_usage_summary(p_tz text) to authenticated;
grant execute on function public.jarvis_usage_summary(p_tz text) to service_role;
revoke all on table public.jarvis_usage from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.jarvis_usage to service_role;
revoke all on table public.lead_contact_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_contact_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_contact_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_contact_log to service_role;
revoke all on table public.lead_delivery_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_delivery_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_delivery_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_delivery_log to service_role;
revoke all on table public.lead_disputes from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_disputes to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_disputes to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_disputes to service_role;
revoke all on table public.lead_pricing_areas from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_pricing_areas to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_pricing_areas to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_pricing_areas to service_role;
revoke all on table public.lead_sms_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_sms_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_sms_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.lead_sms_log to service_role;
revoke all on table public.leads_daily from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.leads_daily to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.leads_daily to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.leads_daily to service_role;
revoke all on function public.leads_stamp_stage_change() from public, anon, authenticated, service_role;
grant execute on function public.leads_stamp_stage_change() to anon;
grant execute on function public.leads_stamp_stage_change() to authenticated;
grant execute on function public.leads_stamp_stage_change() to public;
grant execute on function public.leads_stamp_stage_change() to service_role;
revoke all on table public.leads from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.leads to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.leads to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.leads to service_role;
revoke all on function public.managed_active_default_ads_live() from public, anon, authenticated, service_role;
grant execute on function public.managed_active_default_ads_live() to anon;
grant execute on function public.managed_active_default_ads_live() to authenticated;
grant execute on function public.managed_active_default_ads_live() to public;
grant execute on function public.managed_active_default_ads_live() to service_role;
revoke all on table public.managed_alerts from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_alerts to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_alerts to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_alerts to service_role;
revoke all on table public.managed_campaigns from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_campaigns to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_campaigns to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_campaigns to service_role;
revoke all on table public.managed_launch_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_launch_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_launch_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_launch_log to service_role;
revoke all on table public.managed_order_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_order_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_order_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.managed_order_log to service_role;
revoke all on function public.mark_followup_done(p_lead uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_followup_done(p_lead uuid) to authenticated;
grant execute on function public.mark_followup_done(p_lead uuid) to service_role;
revoke all on function public.mark_lead_delivered(p_lead_id uuid, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.mark_lead_delivered(p_lead_id uuid, p_note text) to authenticated;
grant execute on function public.mark_lead_delivered(p_lead_id uuid, p_note text) to service_role;
revoke all on function public.mark_lead_scrubbed(p_lead_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_lead_scrubbed(p_lead_id uuid) to authenticated;
grant execute on function public.mark_lead_scrubbed(p_lead_id uuid) to service_role;
revoke all on table public.meta_ad_accounts from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_ad_accounts to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_ad_accounts to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_ad_accounts to service_role;
revoke all on table public.meta_api_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_api_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_api_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_api_log to service_role;
revoke all on table public.meta_campaigns from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_campaigns to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_campaigns to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_campaigns to service_role;
revoke all on table public.meta_capi_events from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_capi_events to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_capi_events to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.meta_capi_events to service_role;
revoke all on table public.monthly_goals from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.monthly_goals to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.monthly_goals to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.monthly_goals to service_role;
revoke all on function public.norm_au_phone(p text) from public, anon, authenticated, service_role;
grant execute on function public.norm_au_phone(p text) to anon;
grant execute on function public.norm_au_phone(p text) to authenticated;
grant execute on function public.norm_au_phone(p text) to public;
grant execute on function public.norm_au_phone(p text) to service_role;
revoke all on function public.norm_domain(p text) from public, anon, authenticated, service_role;
grant execute on function public.norm_domain(p text) to anon;
grant execute on function public.norm_domain(p text) to authenticated;
grant execute on function public.norm_domain(p text) to public;
grant execute on function public.norm_domain(p text) to service_role;
revoke all on function public.norm_email(p text) from public, anon, authenticated, service_role;
grant execute on function public.norm_email(p text) to anon;
grant execute on function public.norm_email(p text) to authenticated;
grant execute on function public.norm_email(p text) to public;
grant execute on function public.norm_email(p text) to service_role;
revoke all on function public.outreach_batch_approve(p_ids uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.outreach_batch_approve(p_ids uuid[]) to authenticated;
grant execute on function public.outreach_batch_approve(p_ids uuid[]) to service_role;
revoke all on function public.outreach_batch_candidates(p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.outreach_batch_candidates(p_limit integer) to authenticated;
grant execute on function public.outreach_batch_candidates(p_limit integer) to service_role;
revoke all on function public.outreach_bounce_rate(p_niche text) from public, anon, authenticated, service_role;
grant execute on function public.outreach_bounce_rate(p_niche text) to service_role;
revoke all on function public.outreach_campaign_list() from public, anon, authenticated, service_role;
grant execute on function public.outreach_campaign_list() to authenticated;
grant execute on function public.outreach_campaign_list() to service_role;
revoke all on function public.outreach_claim(p_channel text, p_recipient text, p_message text, p_lead_id uuid, p_days integer) from public, anon, authenticated, service_role;
grant execute on function public.outreach_claim(p_channel text, p_recipient text, p_message text, p_lead_id uuid, p_days integer) to service_role;
revoke all on function public.outreach_daily(p_days integer) from public, anon, authenticated, service_role;
grant execute on function public.outreach_daily(p_days integer) to authenticated;
grant execute on function public.outreach_daily(p_days integer) to service_role;
revoke all on function public.outreach_event_list(p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.outreach_event_list(p_limit integer) to authenticated;
grant execute on function public.outreach_event_list(p_limit integer) to service_role;
revoke all on table public.outreach_events from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.outreach_events to service_role;
revoke all on function public.outreach_funnel(p_days integer) from public, anon, authenticated, service_role;
grant execute on function public.outreach_funnel(p_days integer) to authenticated;
grant execute on function public.outreach_funnel(p_days integer) to service_role;
revoke all on function public.outreach_hash(p_message text) from public, anon, authenticated, service_role;
grant execute on function public.outreach_hash(p_message text) to anon;
grant execute on function public.outreach_hash(p_message text) to authenticated;
grant execute on function public.outreach_hash(p_message text) to public;
grant execute on function public.outreach_hash(p_message text) to service_role;
revoke all on function public.outreach_niche_list() from public, anon, authenticated, service_role;
grant execute on function public.outreach_niche_list() to authenticated;
grant execute on function public.outreach_niche_list() to service_role;
revoke all on function public.outreach_niche_update(p_key text, p_enabled boolean, p_daily_target integer, p_regions text[], p_search_terms text[], p_offer text) from public, anon, authenticated, service_role;
grant execute on function public.outreach_niche_update(p_key text, p_enabled boolean, p_daily_target integer, p_regions text[], p_search_terms text[], p_offer text) to authenticated;
grant execute on function public.outreach_niche_update(p_key text, p_enabled boolean, p_daily_target integer, p_regions text[], p_search_terms text[], p_offer text) to service_role;
revoke all on table public.outreach_niches from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.outreach_niches to service_role;
revoke all on table public.outreach_queries from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.outreach_queries to service_role;
revoke all on function public.outreach_recipient(p_channel text, p_recipient text) from public, anon, authenticated, service_role;
grant execute on function public.outreach_recipient(p_channel text, p_recipient text) to anon;
grant execute on function public.outreach_recipient(p_channel text, p_recipient text) to authenticated;
grant execute on function public.outreach_recipient(p_channel text, p_recipient text) to public;
grant execute on function public.outreach_recipient(p_channel text, p_recipient text) to service_role;
revoke all on function public.outreach_release(p_channel text, p_recipient text, p_message text) from public, anon, authenticated, service_role;
grant execute on function public.outreach_release(p_channel text, p_recipient text, p_message text) to service_role;
revoke all on function public.outreach_run_list(p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.outreach_run_list(p_limit integer) to authenticated;
grant execute on function public.outreach_run_list(p_limit integer) to service_role;
revoke all on function public.outreach_run_now() from public, anon, authenticated, service_role;
grant execute on function public.outreach_run_now() to authenticated;
grant execute on function public.outreach_run_now() to service_role;
revoke all on table public.outreach_runs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.outreach_runs to service_role;
revoke all on table public.outreach_sent from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.outreach_sent to service_role;
revoke all on function public.outreach_sequence_save(p_key text, p_steps jsonb, p_approve boolean) from public, anon, authenticated, service_role;
grant execute on function public.outreach_sequence_save(p_key text, p_steps jsonb, p_approve boolean) to authenticated;
grant execute on function public.outreach_sequence_save(p_key text, p_steps jsonb, p_approve boolean) to service_role;
revoke all on function public.outreach_settings_get() from public, anon, authenticated, service_role;
grant execute on function public.outreach_settings_get() to authenticated;
grant execute on function public.outreach_settings_get() to service_role;
revoke all on function public.outreach_settings_update(p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.outreach_settings_update(p jsonb) to authenticated;
grant execute on function public.outreach_settings_update(p jsonb) to service_role;
revoke all on table public.outreach_settings from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.outreach_settings to service_role;
revoke all on function public.outreach_spend(p_days integer) from public, anon, authenticated, service_role;
grant execute on function public.outreach_spend(p_days integer) to authenticated;
grant execute on function public.outreach_spend(p_days integer) to service_role;
revoke all on table public.pay_rates from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pay_rates to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pay_rates to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pay_rates to service_role;
revoke all on table public.pending_orders from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pending_orders to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pending_orders to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pending_orders to service_role;
revoke all on function public.phone_digits9(p_phone text) from public, anon, authenticated, service_role;
grant execute on function public.phone_digits9(p_phone text) to anon;
grant execute on function public.phone_digits9(p_phone text) to authenticated;
grant execute on function public.phone_digits9(p_phone text) to public;
grant execute on function public.phone_digits9(p_phone text) to service_role;
revoke all on table public.pilot_leads from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_leads to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_leads to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_leads to service_role;
revoke all on table public.pilot_orders from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_orders to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_orders to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.pilot_orders to service_role;
revoke all on table public.ppl_campaign_action_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_campaign_action_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_campaign_action_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_campaign_action_log to service_role;
revoke all on table public.ppl_campaigns from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_campaigns to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_campaigns to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_campaigns to service_role;
revoke all on table public.ppl_lead_areas from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_lead_areas to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_lead_areas to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_lead_areas to service_role;
revoke all on table public.ppl_leads from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_leads to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_leads to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_leads to service_role;
revoke all on table public.ppl_order_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_order_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_order_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.ppl_order_log to service_role;
revoke all on function public.preview_postcode_match(p_postcode text) from public, anon, authenticated, service_role;
grant execute on function public.preview_postcode_match(p_postcode text) to anon;
grant execute on function public.preview_postcode_match(p_postcode text) to authenticated;
grant execute on function public.preview_postcode_match(p_postcode text) to public;
grant execute on function public.preview_postcode_match(p_postcode text) to service_role;
revoke all on function public.prospect_add(p jsonb) from public, anon, authenticated, service_role;
grant execute on function public.prospect_add(p jsonb) to service_role;
revoke all on function public.prospect_block_reason(p_email text, p_phone text, p_domain text, p_exclude uuid) from public, anon, authenticated, service_role;
grant execute on function public.prospect_block_reason(p_email text, p_phone text, p_domain text, p_exclude uuid) to service_role;
revoke all on function public.prospect_delete(p_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.prospect_delete(p_id uuid) to authenticated;
grant execute on function public.prospect_delete(p_id uuid) to service_role;
revoke all on function public.prospect_list(p_niche text, p_status text, p_search text, p_limit integer, p_offset integer) from public, anon, authenticated, service_role;
grant execute on function public.prospect_list(p_niche text, p_status text, p_search text, p_limit integer, p_offset integer) to authenticated;
grant execute on function public.prospect_list(p_niche text, p_status text, p_search text, p_limit integer, p_offset integer) to service_role;
revoke all on function public.prospect_set_opener(p_id uuid, p_opener text) from public, anon, authenticated, service_role;
grant execute on function public.prospect_set_opener(p_id uuid, p_opener text) to authenticated;
grant execute on function public.prospect_set_opener(p_id uuid, p_opener text) to service_role;
revoke all on function public.prospects_before_write() from public, anon, authenticated, service_role;
grant execute on function public.prospects_before_write() to anon;
grant execute on function public.prospects_before_write() to authenticated;
grant execute on function public.prospects_before_write() to public;
grant execute on function public.prospects_before_write() to service_role;
revoke all on table public.prospects from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.prospects to service_role;
revoke all on function public.rep_commission_summary(p_rep uuid) from public, anon, authenticated, service_role;
grant execute on function public.rep_commission_summary(p_rep uuid) to authenticated;
grant execute on function public.rep_commission_summary(p_rep uuid) to service_role;
revoke all on function public.rep_update_lead_stage(p_lead_id uuid, p_stage text) from public, anon, authenticated, service_role;
grant execute on function public.rep_update_lead_stage(p_lead_id uuid, p_stage text) to anon;
grant execute on function public.rep_update_lead_stage(p_lead_id uuid, p_stage text) to authenticated;
grant execute on function public.rep_update_lead_stage(p_lead_id uuid, p_stage text) to service_role;
revoke all on table public.revenue from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.revenue to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.revenue to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.revenue to service_role;
revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role;
grant execute on function public.rls_auto_enable() to anon;
grant execute on function public.rls_auto_enable() to authenticated;
grant execute on function public.rls_auto_enable() to public;
grant execute on function public.rls_auto_enable() to service_role;
revoke all on function public.round_robin_pool() from public, anon, authenticated, service_role;
grant execute on function public.round_robin_pool() to anon;
grant execute on function public.round_robin_pool() to authenticated;
grant execute on function public.round_robin_pool() to public;
grant execute on function public.round_robin_pool() to service_role;
revoke all on table public.sales_email_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_email_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_email_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_email_log to service_role;
revoke all on table public.sales_email_templates from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_email_templates to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_email_templates to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_email_templates to service_role;
revoke all on table public.sales_rep_config from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_rep_config to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_rep_config to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_rep_config to service_role;
revoke all on table public.sales_reps from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_reps to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_reps to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_reps to service_role;
revoke all on table public.sales_sms_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_sms_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_sms_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sales_sms_log to service_role;
revoke all on function public.send_meta_conversion() from public, anon, authenticated, service_role;
grant execute on function public.send_meta_conversion() to anon;
grant execute on function public.send_meta_conversion() to authenticated;
grant execute on function public.send_meta_conversion() to public;
grant execute on function public.send_meta_conversion() to service_role;
revoke all on function public.set_invoice_number() from public, anon, authenticated, service_role;
grant execute on function public.set_invoice_number() to anon;
grant execute on function public.set_invoice_number() to authenticated;
grant execute on function public.set_invoice_number() to public;
grant execute on function public.set_invoice_number() to service_role;
revoke all on function public.set_invoice_owner() from public, anon, authenticated, service_role;
grant execute on function public.set_invoice_owner() to anon;
grant execute on function public.set_invoice_owner() to authenticated;
grant execute on function public.set_invoice_owner() to public;
grant execute on function public.set_invoice_owner() to service_role;
revoke all on function public.set_meta_capi_token(p_token text) from public, anon, authenticated, service_role;
grant execute on function public.set_meta_capi_token(p_token text) to authenticated;
grant execute on function public.set_meta_capi_token(p_token text) to service_role;
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
grant execute on function public.set_updated_at() to anon;
grant execute on function public.set_updated_at() to authenticated;
grant execute on function public.set_updated_at() to public;
grant execute on function public.set_updated_at() to service_role;
revoke all on function public.sms_is_opted_out(p_phone text) from public, anon, authenticated, service_role;
grant execute on function public.sms_is_opted_out(p_phone text) to service_role;
revoke all on table public.sms_opt_outs from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.sms_opt_outs to service_role;
revoke all on function public.sms_set_opt_out(p_phone text, p_opted_out boolean, p_source text) from public, anon, authenticated, service_role;
grant execute on function public.sms_set_opt_out(p_phone text, p_opted_out boolean, p_source text) to service_role;
revoke all on table public.subscriptions from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.subscriptions to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.subscriptions to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.subscriptions to service_role;
revoke all on function public.suppression_add(p_kind text, p_value text, p_note text) from public, anon, authenticated, service_role;
grant execute on function public.suppression_add(p_kind text, p_value text, p_note text) to authenticated;
grant execute on function public.suppression_add(p_kind text, p_value text, p_note text) to service_role;
revoke all on function public.suppression_list(p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.suppression_list(p_limit integer) to authenticated;
grant execute on function public.suppression_list(p_limit integer) to service_role;
revoke all on table public.tasks from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.tasks to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.tasks to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.tasks to service_role;
revoke all on function public.update_order_status() from public, anon, authenticated, service_role;
grant execute on function public.update_order_status() to anon;
grant execute on function public.update_order_status() to authenticated;
grant execute on function public.update_order_status() to public;
grant execute on function public.update_order_status() to service_role;
revoke all on table public.webhook_delivery_log from public, anon, authenticated, service_role;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.webhook_delivery_log to anon;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.webhook_delivery_log to authenticated;
grant DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on table public.webhook_delivery_log to service_role;

-- ===== Realtime, storage buckets and comments =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('jarvis-content', 'jarvis-content', true, null, null) on conflict (id) do nothing;
comment on column public.business_settings.don_active is 'Mirror of ql-hq sms_agent_config.is_active. False means the config is not even attached to the inbound path, so switching auto_reply on alone would not wake him.';
comment on column public.business_settings.don_enabled is 'Mirror of ql-hq sms_agent_config.auto_reply for the agency''s own agent. Null means never synced.';
comment on column public.business_settings.don_synced_at is 'When the mirror was last refreshed. A stale value means the sync is failing, which the watcher treats as not-knowing rather than as "off".';
comment on column public.business_settings.jarvis_call_enabled is 'Allow Jarvis to place a voice call for urgent events. Requires a voice-capable Twilio number.';
comment on column public.business_settings.jarvis_call_voice is 'The Twilio Polly voice used for outbound calls, e.g. Polly.Brian-Neural. Included in the call price.';
comment on column public.business_settings.jarvis_from_number is 'Twilio number Jarvis sends from and receives replies on. NULL = fall back to twilio_from_number (outbound only, replies not routed).';
comment on column public.business_settings.jarvis_notify_number is 'AU mobile Jarvis sends alerts to. NULL or jarvis_notify_enabled=false means he stays quiet.';
comment on column public.business_settings.jarvis_owner_email is 'Account the SMS bridge authenticates as when calling jarvis-chat. Must be a non-rep account.';
comment on column public.business_settings.sales_from_email is 'From address for sales info/follow-up emails. Must be on a Resend-verified domain. NULL = fall back to the RESEND_FROM_EMAIL secret.';
comment on column public.business_settings.sales_reply_to_email is 'Reply-To for sales email when the sender has no per-rep reply address. Reps keep their own. Unlike the From address this need not be on a verified domain.';
comment on column public.client_action_log.actor_name is 'Who logged it, denormalised so the row stays readable after the account goes. NULL on rows that pre-date this column.';
comment on column public.clients.fulfilment_next_due is 'When fulfilment_next_step falls due, from its SLA in ql-hq. Past = stuck. Set by the mirror, never by hand.';
comment on column public.clients.fulfilment_next_step is 'The step this client is actually waiting on, as a ql-hq step_key. NULL once onboarding is complete.';
comment on column public.clients.fulfilment_steps_done is 'Required steps actually ticked. Lower than settled where steps were skipped - e.g. a client who pre-dates step tracking.';
comment on column public.clients.fulfilment_steps_settled is 'Required steps done or deliberately skipped, out of fulfilment_steps_total. The progress numerator: skipping a step is still progress past it.';
comment on column public.clients.fulfilment_synced_at is 'Last time ql-hq pushed this client''s summary. Stale or NULL on an active onboarding client means the mirror is not arriving.';
comment on column public.clients.target_leads_month is 'Turnkey Lead Engine: agreed lead volume per month.';
comment on column public.clients.webhook_auth_enabled is 'When true, lead webhooks to this client carry X-QuoteLeads-Signature and X-QuoteLeads-Secret headers.';
comment on column public.clients.webhook_auth_header is 'Header name for mode=header, e.g. Authorization or X-API-Key. Value is stored in webhook_secret.';
comment on column public.clients.webhook_auth_mode is 'none | header (send the client''s credential) | signature (sign with our secret)';
comment on column public.clients.webhook_secret is 'Shared secret for outbound lead webhooks. Readable by admins in Mission Control, matching the existing hq_bearer_token field. Never written to lead_delivery_log.';
comment on function public.find_leads_by_contact(p_email text, p_phone text, p_limit integer) is 'Spam gate for ql-hq growth-onboarding: pipeline leads matching an email or phone, any stage. service_role only - it reads past rep scoping.';
comment on function public.phone_digits9(p_phone text) is 'Last 9 digits of a phone number, so 0412 345 678 and +61412345678 compare equal.';
comment on view public.fulfilment_stuck is 'Clients past an SLA or with a blocked step. One definition of stuck, shared by every reader. Returns nothing to a sales rep via its own predicate, not via the policies on clients.';
comment on table public.hiring_candidates is 'Hiring pipeline - one row per candidate.';
comment on column public.hiring_candidates.rating is 'Internal 0-10 score, same scale as client CX.';
comment on column public.hiring_candidates.role is 'Role applied for, free text.';
comment on column public.leads.hq_company_id is 'companies.id in ql-hq once this won lead has been converted to a client.';
comment on column public.outreach_settings.postal_address is 'Contact details shown in every email footer: ABN, phone or website (Spam Act s17). Named before it was widened.';
comment on column public.outreach_settings.sender_name is 'Optional sign-off name for {sender}; the business name is used when blank.';
comment on column public.sales_email_log.via is 'Null for a send from the dashboard by a signed-in person; ''jarvis'' for one authorised by text or call through the Jarvis bridge.';
comment on table public.sales_email_templates is 'Sales info + follow-up email templates. Placeholders: {first_name}, {company_name}, {rep_name}, {rep_email}.';
comment on column public.sales_reps.reply_to_email is 'Reply-To on sales emails this rep sends. Falls back to sales_reps.email.';

-- ===== Scheduled jobs =====
select cron.schedule('cron-history-trim', '17 3 * * *', '
  delete from cron.job_run_details where end_time < now() - interval ''3 days''
');

select cron.schedule('jarvis-heartbeat', '*/15 * * * *', '
  select net.http_post(
    url     := ''https://wmegoygrancfwxagqskh.supabase.co/functions/v1/jarvis-notify'',
    headers := jsonb_build_object(
                 ''Content-Type'',  ''application/json'',
                 ''Authorization'', ''Bearer '' || (
                   select decrypted_secret from vault.decrypted_secrets
                    where name = ''jarvis_service_key''
                 )
               ),
    body    := ''{}''::jsonb
  );
  ');

select cron.schedule('jarvis-outbox', '*/5 * * * *', '
  select net.http_post(
    url     := ''https://wmegoygrancfwxagqskh.supabase.co/functions/v1/jarvis-outbox'',
    headers := jsonb_build_object(
                 ''Content-Type'',  ''application/json'',
                 ''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''jarvis_service_key'')),
    body    := ''{}''::jsonb)
  where exists (select 1 from public.jarvis_outbox
                 where status = ''queued''
                    or (status = ''sending'' and attempted_at < now() - interval ''10 minutes''))
');

select cron.schedule('managed-campaign-watch', '17 * * * *', ' select net.http_post(
       url     := ''https://wmegoygrancfwxagqskh.supabase.co/functions/v1/managed-campaigns'',
       headers := jsonb_build_object(
                    ''Content-Type'', ''application/json'',
                    ''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''jarvis_service_key'')),
       body    := ''{"action":"watch"}''::jsonb,
       timeout_milliseconds := 120000) ');

select cron.schedule('meta-capi-retry', '*/30 * * * *', ' select net.http_post(
       url     := ''https://wmegoygrancfwxagqskh.supabase.co/functions/v1/meta-capi'',
       headers := jsonb_build_object(
                    ''Content-Type'', ''application/json'',
                    ''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''jarvis_service_key'')),
       body    := ''{"action":"retry"}''::jsonb,
       timeout_milliseconds := 120000) ');

select cron.schedule('no-answer-email', '0 23,0 * * *', '
  select net.http_post(
    url     := ''https://wmegoygrancfwxagqskh.supabase.co/functions/v1/pipeline-no-answer-email'',
    headers := jsonb_build_object(
                 ''Content-Type'',  ''application/json'',
                 ''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''jarvis_service_key'')),
    body    := ''{}''::jsonb)
');

select cron.schedule('ppl-area-refresh', '*/5 * * * *', ' select net.http_post(url:=''https://wmegoygrancfwxagqskh.supabase.co/functions/v1/ppl-area-refresh'', headers:=jsonb_build_object(''Content-Type'',''application/json'',''Authorization'',''Bearer ''||(select decrypted_secret from vault.decrypted_secrets where name=''jarvis_service_key'')), body:=''{}''::jsonb) ');
