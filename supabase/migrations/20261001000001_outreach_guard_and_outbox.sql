-- Never the same message twice, and bulk sends that cannot die halfway.
--
-- On 1 Oct a 180-lead campaign Jarvis was sending one tool call at a time hit
-- the edge function time limit after 17 leads. The thread was never saved, so
-- he then said nothing had gone out, and a "yes" would have started the list
-- again from the top. Three things stop that, and this migration is the first
-- two:
--
--   outreach_sent   a register of what went to which phone or email, checked
--                   and claimed atomically by send-sms and send-sales-email
--                   before anything is sent. The same message to the same
--                   recipient inside 30 days is refused, whoever asks - the
--                   dashboard, a bulk send, Jarvis, a double-click.
--
--   jarvis_outbox   bulk sends as a queue. Jarvis writes the whole list in one
--                   call; jarvis-outbox sends it in small batches, each row
--                   claimed once, so a timeout only pauses it. The cron below
--                   picks it back up within a minute.
--
-- The third, in jarvis-chat, is that the conversation is saved after every
-- tool round and he checks the log before saying what was sent.

-- ── The register ─────────────────────────────────────────────────────────────

-- One message, whoever wrote it: case, spacing and the opt-out footer do not
-- make it a different message.
create or replace function public.outreach_hash(p_message text)
returns text
language sql
immutable
as $$
  select md5(btrim(regexp_replace(
           regexp_replace(lower(coalesce(p_message, '')), 'reply stop to opt out\.?', '', 'g'),
           '\s+', ' ', 'g')))
$$;

create or replace function public.outreach_recipient(p_channel text, p_recipient text)
returns text
language sql
immutable
as $$
  select case when p_channel = 'sms' then public.norm_au_phone(p_recipient)
              else lower(btrim(coalesce(p_recipient, ''))) end
$$;

create table if not exists public.outreach_sent (
  channel     text        not null check (channel in ('sms', 'email')),
  recipient   text        not null,   -- E.164 phone, or lowercased email
  msg_hash    text        not null,   -- outreach_hash() of the message
  lead_id     uuid,
  claimed_at  timestamptz not null default now(),
  primary key (channel, recipient, msg_hash)
);
create index if not exists outreach_sent_recipient_idx on public.outreach_sent (recipient, claimed_at desc);

alter table public.outreach_sent enable row level security;
alter table public.outreach_sent force  row level security;
revoke all on table public.outreach_sent from public, anon, authenticated;
grant all  on table public.outreach_sent to service_role;

-- Claim the right to send. True: go ahead. False: this exact message already
-- went to this recipient within p_days. Atomic, so two simultaneous requests
-- cannot both win.
create or replace function public.outreach_claim(
  p_channel text, p_recipient text, p_message text, p_lead_id uuid default null, p_days int default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- Give a claim back when the provider rejected the send, so it can be retried.
create or replace function public.outreach_release(p_channel text, p_recipient text, p_message text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.outreach_sent
   where channel = p_channel
     and recipient = public.outreach_recipient(p_channel, p_recipient)
     and msg_hash = public.outreach_hash(p_message)
$$;

revoke all on function public.outreach_claim(text, text, text, uuid, int) from public, anon, authenticated;
revoke all on function public.outreach_release(text, text, text)           from public, anon, authenticated;
grant execute on function public.outreach_claim(text, text, text, uuid, int) to service_role;
grant execute on function public.outreach_release(text, text, text)           to service_role;

-- What already went out in the last 30 days counts, today's partial campaign
-- included.
insert into public.outreach_sent (channel, recipient, msg_hash, lead_id, claimed_at)
select distinct on (1, 2, 3) 'sms', public.norm_au_phone(to_number), public.outreach_hash(message), lead_id, created_at
  from public.sales_sms_log
 where direction = 'outbound' and status <> 'failed' and to_number is not null
   and created_at > now() - interval '30 days'
 order by 1, 2, 3, created_at desc
on conflict do nothing;

insert into public.outreach_sent (channel, recipient, msg_hash, lead_id, claimed_at)
select distinct on (1, 2, 3) 'email', lower(btrim(to_email)), public.outreach_hash(subject || E'\n' || body), lead_id, sent_at
  from public.sales_email_log
 where to_email is not null and sent_at > now() - interval '30 days'
 order by 1, 2, 3, sent_at desc
on conflict do nothing;

-- Campaign emails: not the Send Info / Follow Up buttons, so they must not
-- stamp the lead and grey those buttons out.
alter table public.sales_email_log drop constraint if exists sales_email_log_kind_check;
alter table public.sales_email_log
  add constraint sales_email_log_kind_check check (kind in ('info', 'followup', 'campaign'));

-- ── The outbox ───────────────────────────────────────────────────────────────

create table if not exists public.jarvis_outbox (
  id           uuid        primary key default gen_random_uuid(),
  campaign_id  uuid        not null,
  campaign     text        not null,
  lead_id      uuid        not null,
  lead_name    text,
  channel      text        not null check (channel in ('sms', 'email')),
  recipient    text,
  subject      text,
  body         text        not null,
  status       text        not null default 'queued'
               check (status in ('queued', 'sending', 'sent', 'skipped', 'failed')),
  detail       text,
  created_at   timestamptz not null default now(),
  attempted_at timestamptz,
  sent_at      timestamptz,
  unique (campaign_id, lead_id, channel)
);
create index if not exists jarvis_outbox_queue_idx on public.jarvis_outbox (status, created_at) where status in ('queued', 'sending');
create index if not exists jarvis_outbox_campaign_idx on public.jarvis_outbox (campaign_id);
create index if not exists jarvis_outbox_lead_idx on public.jarvis_outbox (lead_id, created_at desc);

alter table public.jarvis_outbox enable row level security;
alter table public.jarvis_outbox force  row level security;
revoke all on table public.jarvis_outbox from public, anon, authenticated;
grant all  on table public.jarvis_outbox to service_role;

-- Hand a worker the next rows, each to exactly one worker. A row stuck in
-- 'sending' for 10 minutes (a worker killed mid-send) is retried; if it did go
-- out, outreach_claim refuses it and it is marked skipped, not sent twice.
create or replace function public.jarvis_outbox_claim(p_limit int default 5)
returns setof public.jarvis_outbox
language sql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.jarvis_outbox_claim(int) from public, anon, authenticated;
grant execute on function public.jarvis_outbox_claim(int) to service_role;

-- Safety net: if a worker dies, the queue is picked up again within a minute.
-- Only calls out when there is something to send.
select cron.unschedule('jarvis-outbox') where exists (select 1 from cron.job where jobname = 'jarvis-outbox');
select cron.schedule('jarvis-outbox', '* * * * *', $cron$
  select net.http_post(
    url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/jarvis-outbox',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
    body    := '{}'::jsonb)
  where exists (select 1 from public.jarvis_outbox
                 where status = 'queued'
                    or (status = 'sending' and attempted_at < now() - interval '10 minutes'))
$cron$);
