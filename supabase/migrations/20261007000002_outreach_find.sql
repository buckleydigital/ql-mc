-- Cold outreach stage 2: find and verify.
--
-- outreach-find runs once a day (and on "Run now"): for each niche that is
-- switched on it searches Google Places, reads each business's website for a
-- published email (recording the page it was on), and checks the address with
-- MillionVerifier. What it finds lands in prospects, through the same trigger
-- that blocks anyone in the pipeline, a client, opted out or on the
-- do-not-contact list. Nothing is sent from here.

-- ── Which searches have been run ─────────────────────────────────────────────
-- One row per niche + query ("solar installer Mackay QLD"). A query is run to
-- the end of its results (up to 60), then rested; after 90 days it is run
-- again to pick up businesses that are new since.
create table if not exists public.outreach_queries (
  niche_key    text        not null references public.outreach_niches (key),
  query        text        not null,
  runs         int         not null default 0,
  results      int         not null default 0,   -- places returned, last run
  added        int         not null default 0,   -- new prospects, all runs
  last_run_at  timestamptz,
  primary key (niche_key, query)
);

alter table public.outreach_queries enable row level security;
alter table public.outreach_queries force  row level security;
revoke all on table public.outreach_queries from public, anon, authenticated;
grant all  on table public.outreach_queries to service_role;

-- ── Run log ──────────────────────────────────────────────────────────────────
create table if not exists public.outreach_runs (
  id           uuid        primary key default gen_random_uuid(),
  trigger      text        not null default 'cron',   -- cron | manual | continue
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  searches     int         not null default 0,
  found        int         not null default 0,   -- new prospects saved
  blocked      int         not null default 0,   -- of those, blocked on the way in
  emails       int         not null default 0,   -- websites where an email was found
  no_email     int         not null default 0,
  verified     int         not null default 0,
  invalid      int         not null default 0,
  errors       text[]      not null default '{}',
  note         text
);
create index if not exists outreach_runs_started_idx on public.outreach_runs (started_at desc);

alter table public.outreach_runs enable row level security;
alter table public.outreach_runs force  row level security;
revoke all on table public.outreach_runs from public, anon, authenticated;
grant all  on table public.outreach_runs to service_role;

-- ── Saving a place ───────────────────────────────────────────────────────────
-- Insert, or nothing if the business is already a prospect (same place, ABN,
-- website or email, by any of the unique indexes). Returns the new row's id
-- and status - 'blocked' when the trigger refused it - or no row at all.
create or replace function public.prospect_add(p jsonb)
returns table (id uuid, status text, status_reason text)
language sql security definer set search_path = public as $$
  insert into public.prospects as x
    (niche_key, business_name, website, phone, address, suburb, state, postcode,
     google_place_id, source, source_ref, meta)
  values
    (p->>'niche_key', p->>'business_name', p->>'website', p->>'phone', p->>'address',
     p->>'suburb', p->>'state', p->>'postcode', p->>'google_place_id',
     coalesce(p->>'source', 'google_places'), p->>'source_ref', coalesce(p->'meta', '{}'::jsonb))
  on conflict do nothing
  returning x.id, x.status, x.status_reason
$$;

revoke all on function public.prospect_add(jsonb) from public, anon, authenticated;
grant execute on function public.prospect_add(jsonb) to service_role;

-- ── Dashboard: last runs, and "Run now" ──────────────────────────────────────
create or replace function public.outreach_run_list(p_limit int default 10)
returns setof public.outreach_runs
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  return query
    select * from public.outreach_runs order by started_at desc
     limit least(greatest(coalesce(p_limit, 10), 1), 50);
end;
$$;

-- Starts a run now. Finding only - it costs a few cents of searches and
-- verifications, and sends nothing.
create or replace function public.outreach_run_now()
returns void language plpgsql security definer set search_path = public as $$
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
$$;

revoke all on function public.outreach_run_list(int) from public, anon;
revoke all on function public.outreach_run_now()     from public, anon;
grant execute on function public.outreach_run_list(int) to authenticated;
grant execute on function public.outreach_run_now()     to authenticated;

-- ── Daily, 6am Brisbane ──────────────────────────────────────────────────────
-- Only calls out when a niche is switched on.
select cron.unschedule('outreach-find') where exists (select 1 from cron.job where jobname = 'outreach-find');
select cron.schedule('outreach-find', '0 20 * * *', $cron$
  select net.http_post(
    url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/outreach-find',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
    body    := '{"action":"run","trigger":"cron"}'::jsonb)
  where exists (select 1 from public.outreach_niches where enabled and daily_target > 0)
$cron$);
