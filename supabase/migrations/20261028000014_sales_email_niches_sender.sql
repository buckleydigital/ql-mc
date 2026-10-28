-- Sales emails by niche, and an editable sender name.
--
-- sales_email_templates stays the default for every niche. A niche can have
-- its own version of any of the three emails in sales_email_template_niches;
-- a lead in that niche gets it, every other lead gets the default. Niche keys
-- are lower case ('solar', 'hvac', 'roofing').
--
-- The solar wording that used to be the default moves to the solar version,
-- and the defaults lose the solar-only lines.
--
-- business_settings.sales_from_name is the name sales email comes from.
-- {rep_name} is the sending rep. Blank means "{rep_name} at QuoteLeads".

create table if not exists public.sales_email_template_niches (
  kind       text not null check (kind in ('info', 'info_5k', 'followup')),
  niche      text not null check (niche = lower(btrim(niche)) and niche <> ''),
  subject    text not null default '',
  body       text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (kind, niche)
);
alter table public.sales_email_template_niches enable row level security;
revoke all on public.sales_email_template_niches from anon;
grant select, insert, update, delete on public.sales_email_template_niches to authenticated, service_role;
do $$ begin
  if not exists (select 1 from pg_policy where polrelid = 'public.sales_email_template_niches'::regclass and polname = 'setn_select') then
    create policy setn_select on public.sales_email_template_niches for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.sales_email_template_niches'::regclass and polname = 'setn_write') then
    create policy setn_write on public.sales_email_template_niches for all to authenticated
      using (not public.is_sales_rep()) with check (not public.is_sales_rep());
  end if;
end $$;

alter table public.business_settings add column if not exists sales_from_name text;

-- The current offer emails are solar emails: keep them as the solar version.
insert into public.sales_email_template_niches (kind, niche, subject, body, updated_at, updated_by)
select kind, 'solar', subject, body, now(), updated_by
  from public.sales_email_templates
 where kind in ('info', 'info_5k')
on conflict (kind, niche) do nothing;

-- And take the solar-only lines out of the defaults.
update public.sales_email_templates
   set body = replace(replace(replace(replace(body,
         'gets qualified solar enquiries flowing quickly', 'gets qualified enquiries flowing quickly'),
         E'• Average quarterly bill\n', E'• Job details\n'),
         'https://quoteleads.com.au/branded-solar-lead-system', 'https://quoteleads.com.au/pricing'),
         'qualified solar enquiries', 'qualified enquiries'),
       updated_at = now()
 where kind in ('info', 'info_5k');

-- A new pipeline lead has no niche until one is known. It used to default to
-- 'solar', which made every lead added by hand a solar lead.
alter table public.leads alter column niche set default '';
