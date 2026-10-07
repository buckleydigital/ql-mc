-- Cold outreach stage 4: sending through Instantly.
--
-- Each niche gets a sequence (two to four short emails) that you approve in
-- the dashboard, and one Instantly campaign that sends it from your warmed
-- inboxes. Each day you approve a batch of qualified prospects; only then are
-- they pushed into that niche's campaign. Instantly reports back by webhook
-- (outreach-webhook): sent, replied, bounced, unsubscribed, interested...
-- which move the prospect along, add to the do-not-contact list, and turn an
-- interested reply into a Sales Pipeline lead.
--
-- Nothing here sends on its own: no approved sequence, no campaign; no
-- approved batch, no leads in it.

-- ── Who the emails are from ─────────────────────────────────────────────────
-- The Spam Act requires every commercial email to identify the sender and how
-- to reach them, and to carry a working unsubscribe. The footer is built from
-- this row, and a campaign is not synced until it is filled in.
create table if not exists public.outreach_settings (
  id               int         primary key default 1 check (id = 1),
  sender_name      text,
  business_name    text        not null default 'QuoteLeads',
  postal_address   text,
  -- Instantly inbox addresses that send; empty means none chosen yet.
  sending_accounts text[]      not null default '{}',
  send_from        text        not null default '08:30' check (send_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  send_to          text        not null default '16:30' check (send_to   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone         text        not null default 'Australia/Brisbane',
  -- Emails a day per niche campaign, across its inboxes.
  daily_limit      int         not null default 30 check (daily_limit between 1 and 500),
  webhook_id       text,
  webhook_secret   text,       -- the header Instantly presents; never sent to the browser
  updated_at       timestamptz not null default now()
);
insert into public.outreach_settings (id) values (1) on conflict (id) do nothing;

alter table public.outreach_settings enable row level security;
alter table public.outreach_settings force  row level security;
revoke all on table public.outreach_settings from public, anon, authenticated;
grant all  on table public.outreach_settings to service_role;

-- ── Per niche: the sequence and its campaign ────────────────────────────────
-- sequence: [{subject, body, delay_days}], delay_days being the wait before
-- that step (ignored on the first). Editing unapproves it.
alter table public.outreach_niches add column if not exists sequence              jsonb       not null default '[]'::jsonb;
alter table public.outreach_niches add column if not exists sequence_approved_at  timestamptz;
alter table public.outreach_niches add column if not exists instantly_campaign_id text;
alter table public.outreach_niches add column if not exists campaign_synced_at    timestamptz;
alter table public.outreach_niches add column if not exists campaign_state        text;   -- active | paused | draft, as last seen

alter table public.prospects add column if not exists queued_at          timestamptz;
alter table public.prospects add column if not exists instantly_pushed_at timestamptz;

-- ── What Instantly told us ──────────────────────────────────────────────────
create table if not exists public.outreach_events (
  id           uuid        primary key default gen_random_uuid(),
  received_at  timestamptz not null default now(),
  event_type   text        not null,
  campaign_id  text,
  lead_email   text,
  prospect_id  uuid,
  step         int,
  email_id     text,        -- reply_to_uuid: what a reply from Mission Control answers
  subject      text,
  body         text,
  handled      text,        -- what we did about it
  payload      jsonb       not null default '{}'::jsonb
);
create index if not exists outreach_events_received_idx on public.outreach_events (received_at desc);
create index if not exists outreach_events_prospect_idx on public.outreach_events (prospect_id, received_at desc);

alter table public.outreach_events enable row level security;
alter table public.outreach_events force  row level security;
revoke all on table public.outreach_events from public, anon, authenticated;
grant all  on table public.outreach_events to service_role;

-- ── Dashboard RPCs (operators only) ─────────────────────────────────────────

create or replace function public.outreach_settings_get()
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
$$;

create or replace function public.outreach_settings_update(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  update public.outreach_settings set
    sender_name      = coalesce(nullif(btrim(p->>'sender_name'), ''), sender_name),
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
$$;

-- Saves a niche's sequence; p_approve marks it ready to send. Any edit
-- without p_approve leaves it unapproved, so nothing changed goes out unseen.
create or replace function public.outreach_sequence_save(p_key text, p_steps jsonb, p_approve boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare s jsonb; n int;
begin
  perform public.jarvis_assert_operator();
  if jsonb_typeof(p_steps) <> 'array' then raise exception 'Steps must be a list' using errcode = '22023'; end if;
  n := jsonb_array_length(p_steps);
  if n < 1 or n > 4 then raise exception 'A sequence has 1 to 4 emails' using errcode = '22023'; end if;
  for s in select * from jsonb_array_elements(p_steps) loop
    if coalesce(btrim(s->>'subject'), '') = '' or coalesce(btrim(s->>'body'), '') = '' then
      raise exception 'Every email needs a subject and a body' using errcode = '22023';
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
$$;

-- Everything the Sending tab shows per niche.
create or replace function public.outreach_campaign_list()
returns table (key text, label text, enabled boolean, offer text, sequence jsonb, sequence_approved_at timestamptz,
               instantly_campaign_id text, campaign_synced_at timestamptz, campaign_state text,
               queued bigint, contacted bigint, replied bigint, interested bigint)
language plpgsql stable security definer set search_path = public as $$
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
$$;

-- Today's candidates: qualified prospects, best first.
create or replace function public.outreach_batch_candidates(p_limit int default 200)
returns table (id uuid, niche_key text, business_name text, website text, email text, email_source_url text,
               contact_name text, suburb text, state text, fit_score numeric, opener text, status_reason text,
               found_at timestamptz, sequence_ready boolean)
language plpgsql stable security definer set search_path = public as $$
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
$$;

-- Lets you fix an opening line before approving.
create or replace function public.prospect_set_opener(p_id uuid, p_opener text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  update public.prospects set opener = nullif(btrim(p_opener), '') where id = p_id and status = 'qualified';
end;
$$;

-- Approves a batch: every safety rule is checked again here, at the moment of
-- approval, and only what passes is queued. outreach-send then pushes the
-- queued prospects into their niche's campaign.
create or replace function public.outreach_batch_approve(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
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
$$;

-- Recent events, for the Sending tab.
create or replace function public.outreach_event_list(p_limit int default 50)
returns table (received_at timestamptz, event_type text, lead_email text, business_name text, subject text, body text, handled text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  return query
    select e.received_at, e.event_type, e.lead_email, p.business_name, e.subject, left(e.body, 600), e.handled
      from public.outreach_events e left join public.prospects p on p.id = e.prospect_id
     order by e.received_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke all on function public.outreach_settings_get()                         from public, anon;
revoke all on function public.outreach_settings_update(jsonb)                 from public, anon;
revoke all on function public.outreach_sequence_save(text, jsonb, boolean)    from public, anon;
revoke all on function public.outreach_campaign_list()                        from public, anon;
revoke all on function public.outreach_batch_candidates(int)                  from public, anon;
revoke all on function public.prospect_set_opener(uuid, text)                 from public, anon;
revoke all on function public.outreach_batch_approve(uuid[])                  from public, anon;
revoke all on function public.outreach_event_list(int)                        from public, anon;
grant execute on function public.outreach_settings_get()                      to authenticated;
grant execute on function public.outreach_settings_update(jsonb)              to authenticated;
grant execute on function public.outreach_sequence_save(text, jsonb, boolean) to authenticated;
grant execute on function public.outreach_campaign_list()                     to authenticated;
grant execute on function public.outreach_batch_candidates(int)               to authenticated;
grant execute on function public.prospect_set_opener(uuid, text)              to authenticated;
grant execute on function public.outreach_batch_approve(uuid[])               to authenticated;
grant execute on function public.outreach_event_list(int)                     to authenticated;
