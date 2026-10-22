-- Two offer emails on a pipeline lead instead of one Send Info:
--   info     the 2.5K offer (the existing info email, now $690/month after
--            the first 30 days)
--   info_5k  the 5K offer: Meta and Google, or up to 2 areas
-- Each goes once per lead, tracked on its own stamp.

alter table public.sales_email_templates drop constraint if exists sales_email_templates_kind_check;
alter table public.sales_email_templates
  add constraint sales_email_templates_kind_check check (kind in ('info', 'info_5k', 'followup'));

alter table public.sales_email_log drop constraint if exists sales_email_log_kind_check;
alter table public.sales_email_log
  add constraint sales_email_log_kind_check check (kind in ('info', 'info_5k', 'followup', 'campaign', 'no_answer'));

alter table public.leads
  add column if not exists info_5k_sent_at timestamptz,
  add column if not exists info_5k_sent_by uuid;

insert into public.sales_email_templates (kind, subject, body) values
('info_5k',
 'Your lead system, {company_name}',
 E'Hi {first_name},\n\nReally enjoyed speaking with you today.\n\nHere''s how we can work together - we build a complete lead generation system under your own brand, with more reach than our standard build from day one.\n\n------------------------------\nBRANDED LEAD GEN SYSTEM - GROWTH (your brand)\n------------------------------\n\nWe build a complete lead generation system on your own accounts, under the {company_name} brand, and it''s yours to keep.\n\nThis build covers either:\n• Meta and Google - campaigns on both platforms, built and managed together, or\n• Two areas - up to 2 campaigns managed, local, state-wide or nationwide\n\nWe build and launch the whole thing for you:\n• Done-for-you ad campaigns - your accounts, your brand, your creatives, your service areas\n• Custom 3+ step survey funnel that filters out tyre-kickers before they reach you\n• Server-side tracking, conversion mapping and attribution\n• Custom integrations into your CRM, job management software, email and SMS\n• Full ownership of all advertising assets from day one - ad accounts, lead survey and lead data, all in your name\n\nEach lead comes through with:\n• Full name\n• Email\n• Phone\n• Postcode\n• Average quarterly bill\n• Purchase timeline\n• Any custom fields you require\n\nThe QuoteLeadsHQ platform is included:\n• CRM pipeline with full lead history\n• AI SMS agent (optional) - first contact in 3 seconds\n\nYou can learn more here: https://quoteleads.com.au/branded-solar-lead-system\n\nOne-time build + first 30 days management: $5,000 + GST.\n\nOngoing management after the first month is optional at $1,200/month.\n\nAd spend is paid directly to Meta/Google by you, set to suit the platforms and areas you choose.\n\nNo lock-in, cancel anytime and the system stays yours.\n\nResults guarantee: if you don''t see results in the first 30 days, you don''t pay. Details: https://quoteleads.com.au/quoteleads-terms\n\nOnce onboarding is completed, we can have everything built and live within 24-48 hours.\n\n------------------------------\n\nHappy to run through it in more detail. Just reply to this email or give me a call back and we can get you started.\n\nReally looking forward to working with you and helping get some additional qualified opportunities flowing through.\n\nCheers,\n\n{rep_name}\nQuoteLeads')
on conflict (kind) do nothing;

update public.sales_email_templates
   set body = replace(body, 'starting at $600/month', 'starting at $690/month'), updated_at = now()
 where kind = 'info' and body like '%starting at $600/month%';
