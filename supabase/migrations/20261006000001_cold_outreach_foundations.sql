-- Cold outreach, stage 1: where prospects live, which niches are on, and who
-- must never be contacted.
--
-- Nothing here finds or sends anything. It is the ground the later stages
-- stand on, and it is built first because the two things that sink cold
-- email - contacting someone who said no, and not being able to say where an
-- address came from - are both decided here, not at send time.
--
--   prospects              cold prospects, separate from leads (the sales
--                          pipeline). Every row records where it was found
--                          and where its email address was published: under
--                          the Spam Act a cold commercial email relies on the
--                          address being conspicuously published by the
--                          business, so that provenance is the legal record.
--                          One business is one row, whichever niche or source
--                          found it.
--   outreach_niches        the four niches, each switched on or off, with its
--                          own daily target, regions, search terms and offer.
--   contact_suppressions   the shared do-not-contact list: emails, phones and
--                          whole business domains. Checked by prospecting and
--                          by the existing send-sms / send-sales-email, so an
--                          unsubscribe anywhere holds everywhere.
--
-- A prospect who is already a pipeline lead, a client, opted out of SMS or on
-- the do-not-contact list is marked 'blocked' the moment it is added.

-- ── Normalising ──────────────────────────────────────────────────────────────

create or replace function public.norm_email(p text)
returns text language sql immutable as $$
  select nullif(lower(btrim(coalesce(p, ''))), '')
$$;

-- example.com.au from "https://www.Example.com.au/contact?x=1"
create or replace function public.norm_domain(p text)
returns text language sql immutable as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(coalesce(p, ''))), '^[a-z]+://', ''),
        '^www\.', ''),
      '[/:?#].*$', ''),
    '')
$$;

create or replace function public.email_domain(p text)
returns text language sql immutable as $$
  select nullif(split_part(public.norm_email(p), '@', 2), '')
$$;

-- Webmail. Most tradies use one of these, so a domain here says nothing about
-- which business an address belongs to: it must never be used to match,
-- dedupe or block a business by domain, or one Gmail unsubscribe would block
-- every Gmail tradie in the country.
create or replace function public.is_free_mail_domain(p text)
returns boolean language sql immutable as $$
  select coalesce(lower(p), '') = any (array[
    'gmail.com','googlemail.com','outlook.com','outlook.com.au','hotmail.com','hotmail.com.au',
    'live.com','live.com.au','msn.com','yahoo.com','yahoo.com.au','ymail.com','icloud.com','me.com',
    'mac.com','bigpond.com','bigpond.net.au','bigpond.com.au','optusnet.com.au','iinet.net.au',
    'westnet.com.au','tpg.com.au','internode.on.net','dodo.com.au','aapt.net.au','ozemail.com.au',
    'adam.com.au','people.net.au','aol.com','protonmail.com','proton.me','gmx.com','mail.com',
    'zoho.com','fastmail.com','fastmail.fm'
  ])
$$;

-- The domain that identifies the business: its website, or failing that its
-- email domain when that is not webmail.
create or replace function public.business_domain(p_website text, p_email text)
returns text language sql immutable as $$
  select coalesce(
    public.norm_domain(p_website),
    case when public.is_free_mail_domain(public.email_domain(p_email)) then null
         else public.email_domain(p_email) end)
$$;

-- ── Niches ───────────────────────────────────────────────────────────────────

create table if not exists public.outreach_niches (
  key           text        primary key,
  label         text        not null,
  enabled       boolean     not null default false,
  -- New prospects a day for this niche, once sending is live.
  daily_target  int         not null default 25 check (daily_target between 0 and 300),
  -- Empty means nationwide. Otherwise states or places, e.g. {QLD, "Newcastle NSW"}.
  regions       text[]      not null default '{}',
  search_terms  text[]      not null default '{}',
  -- What we are offering this niche, in plain words. The sequence is written
  -- from this, so a roofer and a solar installer get different pitches.
  offer         text,
  notes         text,
  sort_order    int         not null default 0,
  updated_at    timestamptz not null default now()
);

insert into public.outreach_niches (key, label, search_terms, sort_order) values
  ('solar',       'Solar & battery', '{solar installer,solar panel installation,solar battery installer,home battery installer}', 1),
  ('hvac',        'HVAC',            '{air conditioning installer,ducted air conditioning,split system installation,heating and cooling}', 2),
  ('renovations', 'Renovations',     '{home renovation builder,kitchen renovation,bathroom renovation,home extensions builder}', 3),
  ('roofing',     'Roofing',         '{roofing contractor,roof restoration,re-roofing,metal roofing installer}', 4)
on conflict (key) do nothing;

alter table public.outreach_niches enable row level security;
alter table public.outreach_niches force  row level security;
revoke all on table public.outreach_niches from public, anon, authenticated;
grant all  on table public.outreach_niches to service_role;

-- ── The do-not-contact list ──────────────────────────────────────────────────

create table if not exists public.contact_suppressions (
  id          uuid        primary key default gen_random_uuid(),
  kind        text        not null check (kind in ('email', 'phone', 'domain')),
  value       text        not null,   -- normalised: lowercased email/domain, E.164 phone
  reason      text        not null check (reason in
                ('unsubscribed', 'bounced', 'complained', 'not_interested', 'do_not_contact', 'manual')),
  source      text,                   -- cold-email, sms, dashboard, jarvis, ...
  note        text,
  created_at  timestamptz not null default now(),
  unique (kind, value)
);

alter table public.contact_suppressions enable row level security;
alter table public.contact_suppressions force  row level security;
revoke all on table public.contact_suppressions from public, anon, authenticated;
grant all  on table public.contact_suppressions to service_role;

create or replace function public.contact_suppress(
  p_kind text, p_value text, p_reason text, p_source text default null, p_note text default null
)
returns void language plpgsql security definer set search_path = public as $$
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
  -- An existing entry keeps its first reason: an unsubscribe must not be
  -- downgraded to a manual note by a later, weaker one.
  insert into public.contact_suppressions (kind, value, reason, source, note)
  values (p_kind, v, p_reason, p_source, p_note)
  on conflict (kind, value) do nothing;
end;
$$;

-- For the existing senders: is this address or number on the list? (The SMS
-- opt-out register is checked separately by send-sms, as it always was.)
create or replace function public.contact_is_suppressed(p_email text default null, p_phone text default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.contact_suppressions s
     where (s.kind = 'email'  and s.value = public.norm_email(p_email))
        or (s.kind = 'phone'  and s.value = public.norm_au_phone(p_phone))
        or (s.kind = 'domain' and s.value = public.email_domain(p_email)
            and not public.is_free_mail_domain(public.email_domain(p_email)))
  )
$$;

-- ── Prospects ────────────────────────────────────────────────────────────────

create table if not exists public.prospects (
  id               uuid        primary key default gen_random_uuid(),
  niche_key        text        not null references public.outreach_niches (key),
  business_name    text        not null,
  abn              text,
  website          text,
  domain           text,        -- business_domain(website, email), set by trigger
  email            text,        -- normalised, set by trigger
  -- Where the email was published (contact page, Google listing...). The
  -- Spam Act exemption for cold email rests on this, so it is required before
  -- anything is sent (enforced at queue time, stage 4).
  email_source_url text,
  contact_name     text,
  contact_role     text,
  phone            text,        -- E.164, set by trigger
  address          text,
  suburb           text,
  state            text,
  postcode         text,
  google_place_id  text,
  source           text        not null,  -- google_places, cec, licence_register, manual...
  source_ref       text,                  -- the URL or record it came from
  found_at         timestamptz not null default now(),
  status           text        not null default 'new' check (status in (
                     'new', 'enriched', 'verified', 'qualified', 'rejected', 'blocked',
                     'queued', 'contacted', 'replied', 'interested', 'not_interested',
                     'unsubscribed', 'bounced', 'converted')),
  status_reason    text,
  email_verdict    text        check (email_verdict in ('valid', 'risky', 'invalid', 'unknown')),
  verified_at      timestamptz,
  fit_score        numeric(4, 1),
  fit_notes        text,
  opener           text,        -- the personalised first line, stage 3
  contacted_at     timestamptz,
  last_event_at    timestamptz,
  lead_id          uuid,        -- the pipeline lead it became, if it did
  meta             jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One business, one row: the same place, ABN, website or address found again,
-- by another niche or another source, is the same prospect.
create unique index if not exists prospects_place_uq  on public.prospects (google_place_id) where google_place_id is not null;
create unique index if not exists prospects_abn_uq    on public.prospects (abn)             where abn is not null;
create unique index if not exists prospects_domain_uq on public.prospects (domain)          where domain is not null;
create unique index if not exists prospects_email_uq  on public.prospects (email)           where email is not null;
create index if not exists prospects_status_idx on public.prospects (niche_key, status);
create index if not exists prospects_phone_idx  on public.prospects (phone) where phone is not null;

alter table public.prospects enable row level security;
alter table public.prospects force  row level security;
revoke all on table public.prospects from public, anon, authenticated;
grant all  on table public.prospects to service_role;

-- Matching against the pipeline and clients needs these to be index lookups,
-- not scans, once there are thousands of prospects a month.
create index if not exists leads_email_norm_idx     on public.leads   (public.norm_email(email));
create index if not exists leads_phone_norm_idx     on public.leads   (public.norm_au_phone(phone));
create index if not exists leads_email_domain_idx   on public.leads   (public.email_domain(email));
create index if not exists clients_email_norm_idx   on public.clients (public.norm_email(email));
create index if not exists clients_phone_norm_idx   on public.clients (public.norm_au_phone(phone));
create index if not exists clients_email_domain_idx on public.clients (public.email_domain(email));

-- Why this business must not be cold-contacted, or null if it may be.
create or replace function public.prospect_block_reason(
  p_email text, p_phone text, p_domain text, p_exclude uuid default null
)
returns text language plpgsql stable security definer set search_path = public as $$
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

  -- Same phone as another prospect (indexed unique keys catch the rest).
  if ph is not null and exists (select 1 from public.prospects p where p.phone = ph and p.id is distinct from p_exclude) then
    return 'duplicate of another prospect (same phone)';
  end if;

  return null;
end;
$$;

-- Normalise on the way in, and block anything that must not be contacted.
-- Re-checked whenever the contact details change; a prospect already past
-- 'contacted' keeps its status (what happened to it is history).
create or replace function public.prospects_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
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
$$;

drop trigger if exists prospects_before_write on public.prospects;
create trigger prospects_before_write
  before insert or update on public.prospects
  for each row execute function public.prospects_before_write();

-- A new suppression blocks every prospect it matches that has not been sent
-- to yet - an unsubscribe given today must stop tomorrow's batch.
create or replace function public.contact_suppressions_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.prospects p
     set status = 'blocked', status_reason = 'do not contact (' || new.reason || ')'
   where p.status in ('new', 'enriched', 'verified', 'qualified', 'queued')
     and ((new.kind = 'email'  and p.email = new.value)
       or (new.kind = 'phone'  and p.phone = new.value)
       or (new.kind = 'domain' and (p.domain = new.value or public.email_domain(p.email) = new.value)));
  return null;
end;
$$;

drop trigger if exists contact_suppressions_after_insert on public.contact_suppressions;
create trigger contact_suppressions_after_insert
  after insert on public.contact_suppressions
  for each row execute function public.contact_suppressions_after_insert();

revoke all on function public.contact_suppress(text, text, text, text, text)   from public, anon, authenticated;
revoke all on function public.contact_is_suppressed(text, text)                from public, anon, authenticated;
revoke all on function public.prospect_block_reason(text, text, text, uuid)    from public, anon, authenticated;
grant execute on function public.contact_suppress(text, text, text, text, text) to service_role;
grant execute on function public.contact_is_suppressed(text, text)              to service_role;
grant execute on function public.prospect_block_reason(text, text, text, uuid)  to service_role;

-- ── The dashboard's Outreach screen ──────────────────────────────────────────

create or replace function public.outreach_niche_list()
returns table (key text, label text, enabled boolean, daily_target int, regions text[],
               search_terms text[], offer text, notes text, counts jsonb)
language plpgsql stable security definer set search_path = public as $$
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
$$;

create or replace function public.outreach_niche_update(
  p_key text, p_enabled boolean, p_daily_target int, p_regions text[], p_search_terms text[], p_offer text
)
returns void language plpgsql security definer set search_path = public as $$
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
$$;

create or replace function public.suppression_list(p_limit int default 100)
returns table (id uuid, kind text, value text, reason text, source text, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  return query
    select s.id, s.kind, s.value, s.reason, s.source, s.note, s.created_at
      from public.contact_suppressions s
     order by s.created_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 1000);
end;
$$;

create or replace function public.suppression_add(p_kind text, p_value text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  perform public.contact_suppress(p_kind, p_value, 'manual', 'dashboard', p_note);
end;
$$;

-- Removing an entry is deliberately not exposed to the dashboard. An
-- unsubscribe, bounce or complaint is the recipient's decision, not ours; a
-- hand-added entry that was a mistake is rare enough to remove by hand.

revoke all on function public.outreach_niche_list()                                             from public, anon;
revoke all on function public.outreach_niche_update(text, boolean, int, text[], text[], text)   from public, anon;
revoke all on function public.suppression_list(int)                                             from public, anon;
revoke all on function public.suppression_add(text, text, text)                                 from public, anon;
grant execute on function public.outreach_niche_list()                                           to authenticated;
grant execute on function public.outreach_niche_update(text, boolean, int, text[], text[], text) to authenticated;
grant execute on function public.suppression_list(int)                                           to authenticated;
grant execute on function public.suppression_add(text, text, text)                               to authenticated;
