-- Jarvis gets his own number, a conversation, and the ability to ring you.
-- Applied to production 2026-09-18; recorded here so the repo matches.

-- His own sending/receiving number. Twilio allows one inbound webhook per
-- number and the main one is pointed at ql-hq for the client AI agents, so a
-- separate number is the only way replies can reach him. It also means bulk
-- sales SMS getting filtered cannot take the alerting channel down with it.
-- NULL falls back to twilio_from_number: alerts still send, replies go nowhere.
alter table public.business_settings
  add column if not exists jarvis_from_number  text,
  -- Whose account the SMS bridge acts as when calling jarvis-chat.
  add column if not exists jarvis_owner_email  text,
  -- Calls are off independently of SMS, and capped far lower: a phone call is
  -- the most intrusive channel there is, and sharing a cap of 10 would destroy
  -- the distinction within a week.
  add column if not exists jarvis_call_enabled boolean not null default false,
  add column if not exists jarvis_call_cap     integer not null default 3,
  -- Twilio's <Say> takes an Amazon Polly neural voice at no extra cost. It is
  -- the fallback for when ElevenLabs is unreachable or out of credits, not the
  -- voice he normally uses.
  add column if not exists jarvis_call_voice   text    not null default 'Polly.Brian-Neural';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_settings'::regclass
      and conname  = 'business_settings_jarvis_call_cap_check'
  ) then
    alter table public.business_settings
      add constraint business_settings_jarvis_call_cap_check
      check (jarvis_call_cap >= 0 and jarvis_call_cap <= 20);
  end if;
end $$;

-- The conversation, kept apart from client and lead SMS on purpose: this is the
-- owner talking to their own assistant about the whole business, and it has no
-- place in sales_sms_log next to prospect threads.
create table if not exists public.jarvis_messages (
  id           uuid primary key default gen_random_uuid(),
  direction    text        not null check (direction in ('inbound','outbound')),
  body         text        not null,
  from_number  text,
  to_number    text,
  twilio_sid   text,
  -- What he was told about at the time, so a reply of "sort it" has something
  -- to resolve against rather than guessing from the words alone.
  context      jsonb       not null default '{}'::jsonb,
  handled_at   timestamptz,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists jarvis_messages_created_idx
  on public.jarvis_messages (created_at desc);

alter table public.jarvis_messages enable row level security;
alter table public.jarvis_messages force  row level security;
revoke all on table public.jarvis_messages from public, anon, authenticated;
grant all  on table public.jarvis_messages to service_role;

-- Somewhere to put a spoken line so Twilio can fetch it. PRIVATE, and handed
-- over as a short-lived signed URL: these clips name clients and say what is
-- wrong with them, which does not belong on a public URL because the filename
-- happens to be a uuid.
insert into storage.buckets (id, name, public)
values ('jarvis-audio', 'jarvis-audio', false)
on conflict (id) do update set public = false;
