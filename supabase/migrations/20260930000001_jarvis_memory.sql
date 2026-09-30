-- Jarvis remembers.
--
-- Two kinds of memory, kept apart because they live for different lengths of
-- time:
--
--   jarvis_memory   durable facts he has been told - preferences, standing
--                   instructions, context about a client. Read into every
--                   conversation on every channel (panel, SMS, call).
--   jarvis_threads  the panel conversation itself, one per signed-in user, so
--                   a reload or a different device picks up where it left off
--                   instead of starting from nothing.
--
-- Same lockdown as jarvis_messages: service role only. The browser never reads
-- either table; jarvis-chat does, after it has checked who is asking.

create table if not exists public.jarvis_memory (
  id          uuid primary key default gen_random_uuid(),
  content     text        not null check (length(content) between 1 and 1000),
  -- Where he was told: panel, sms, call. Null when unknown.
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists jarvis_memory_created_idx
  on public.jarvis_memory (created_at desc);

alter table public.jarvis_memory enable row level security;
alter table public.jarvis_memory force  row level security;
revoke all on table public.jarvis_memory from public, anon, authenticated;
grant all  on table public.jarvis_memory to service_role;

create table if not exists public.jarvis_threads (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  -- The Messages API transcript, tool calls included, exactly as the model
  -- last saw it. Trimmed by jarvis-chat, never edited by hand.
  messages    jsonb       not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.jarvis_threads enable row level security;
alter table public.jarvis_threads force  row level security;
revoke all on table public.jarvis_threads from public, anon, authenticated;
grant all  on table public.jarvis_threads to service_role;
