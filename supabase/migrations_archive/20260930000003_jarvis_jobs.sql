-- Jarvis schedules his own work, and you can see what he remembers.
--
-- jarvis_jobs: things he has been told to do later or on repeat - "every
-- weekday at 8 text me the numbers", "Thursday, chase Sandford if they have not
-- replied". He creates them with create_job; the 15-minute heartbeat
-- (jarvis-notify) claims the due ones, has jarvis-chat do the work with his
-- full tools and memory, and texts the result.
--
-- Plus the RPCs behind the panel's memory and jobs viewer. Both tables are
-- service-role only; these are the one door in, with the same gate as
-- jarvis_action_log.

create table if not exists public.jarvis_jobs (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  title        text        not null check (length(title) between 1 and 120),
  -- What to do, in words he wrote for himself when the job was set.
  instruction  text        not null check (length(instruction) between 1 and 2000),
  repeat       text        not null default 'once'
               check (repeat in ('once', 'daily', 'weekdays', 'weekly', 'monthly')),
  next_run_at  timestamptz,
  active       boolean     not null default true,
  last_run_at  timestamptz,
  last_result  text,
  runs         int         not null default 0,
  -- panel, sms: where he was asked.
  source       text
);

create index if not exists jarvis_jobs_due_idx
  on public.jarvis_jobs (next_run_at) where active;

alter table public.jarvis_jobs enable row level security;
alter table public.jarvis_jobs force  row level security;
revoke all on table public.jarvis_jobs from public, anon, authenticated;
grant all  on table public.jarvis_jobs to service_role;

-- The next run after `from_ts`, stepping in LOCAL time so "8am daily" stays 8am
-- across a daylight-saving change instead of drifting to 7 or 9.
create or replace function public.jarvis_job_next(
  p_repeat text, p_from timestamptz, p_tz text
) returns timestamptz
language plpgsql
stable
as $$
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
$$;

-- The first run strictly in the future - stepping past any slots missed while
-- the heartbeat was off.
create or replace function public.jarvis_job_next_future(
  p_repeat text, p_from timestamptz, p_tz text
) returns timestamptz
language plpgsql
stable
as $$
declare
  n timestamptz := public.jarvis_job_next(p_repeat, p_from, p_tz);
begin
  while n is not null and n <= now() loop
    n := public.jarvis_job_next(p_repeat, n, p_tz);
  end loop;
  return n;
end;
$$;

-- Claim the due jobs and move each one's schedule on, in one statement, so two
-- overlapping heartbeats can never run the same job twice. A run that fails
-- after this is not retried - better one missed report than a double email.
-- A recurring job that fell far behind (the heartbeat was off for a week)
-- runs once and jumps to its next future slot, rather than firing seven times.
create or replace function public.jarvis_claim_due_jobs(p_limit int default 2, p_tz text default 'Australia/Sydney')
returns setof public.jarvis_jobs
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.jarvis_claim_due_jobs(int, text) from public, anon, authenticated;
grant execute on function public.jarvis_claim_due_jobs(int, text) to service_role;

-- ── The panel's view of his memory and his jobs ────────────────────────────

create or replace function public.jarvis_assert_operator()
returns void
language plpgsql
stable
as $$
begin
  if auth.jwt() is null
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '') in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.jarvis_memory_list()
returns table (id uuid, content text, source text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.jarvis_assert_operator();
  return query
    select m.id, m.content, m.source, m.created_at
      from public.jarvis_memory m order by m.created_at desc limit 500;
end;
$$;

-- Null id adds; an id edits in place.
create or replace function public.jarvis_memory_save(p_id uuid, p_content text)
returns uuid
language plpgsql security definer set search_path = public
as $$
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
$$;

create or replace function public.jarvis_memory_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.jarvis_assert_operator();
  delete from public.jarvis_memory where id = p_id;
end;
$$;

create or replace function public.jarvis_job_list()
returns table (id uuid, title text, instruction text, repeat text, next_run_at timestamptz,
               last_run_at timestamptz, last_result text, runs int)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.jarvis_assert_operator();
  return query
    select j.id, j.title, j.instruction, j.repeat, j.next_run_at, j.last_run_at, j.last_result, j.runs
      from public.jarvis_jobs j where j.active order by j.next_run_at nulls last limit 100;
end;
$$;

create or replace function public.jarvis_job_cancel(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.jarvis_assert_operator();
  update public.jarvis_jobs set active = false where id = p_id;
end;
$$;

revoke all on function public.jarvis_memory_list()             from public, anon;
revoke all on function public.jarvis_memory_save(uuid, text)   from public, anon;
revoke all on function public.jarvis_memory_delete(uuid)       from public, anon;
revoke all on function public.jarvis_job_list()                from public, anon;
revoke all on function public.jarvis_job_cancel(uuid)          from public, anon;
grant execute on function public.jarvis_memory_list()           to authenticated;
grant execute on function public.jarvis_memory_save(uuid, text) to authenticated;
grant execute on function public.jarvis_memory_delete(uuid)     to authenticated;
grant execute on function public.jarvis_job_list()              to authenticated;
grant execute on function public.jarvis_job_cancel(uuid)        to authenticated;
