-- Turnkey Lead Engines (TLE)
--
-- TLE clients live in the existing `clients` table under type = 'tle', so they
-- reuse the same RLS policies, joins and lookups as PPL and Managed clients.
--
-- This migration does three things, all idempotent:
--   1. adds target_leads_month  - the only new field the TLE panel needs;
--   2. makes sure clients.type accepts 'tle', whether that column is plain
--      text with a CHECK constraint, a bare text column (no-op), or an enum;
--   3. indexes clients.type, which every panel now filters on.

alter table public.clients
  add column if not exists target_leads_month integer;

comment on column public.clients.target_leads_month is
  'Turnkey Lead Engine: agreed lead volume per month.';

do $$
declare
  coltype  text;
  enumname text;
  cname    text;
  cdef     text;
  vals     text[];
begin
  select t.typname, case when t.typtype = 'e' then t.typname end
    into coltype, enumname
  from pg_attribute a
  join pg_type t on t.oid = a.atttypid
  where a.attrelid = 'public.clients'::regclass
    and a.attname  = 'type'
    and a.attnum   > 0;

  -- Enum-backed column: just add the label.
  if enumname is not null then
    execute format('alter type public.%I add value if not exists %L', enumname, 'tle');
    raise notice 'enum % now includes ''tle''.', enumname;
    return;
  end if;

  -- Text column: widen the CHECK constraint if there is one.
  select con.conname, pg_get_constraintdef(con.oid)
    into cname, cdef
  from pg_constraint con
  where con.conrelid = 'public.clients'::regclass
    and con.contype  = 'c'
    and pg_get_constraintdef(con.oid) ~ '\mtype\M'
    and pg_get_constraintdef(con.oid) ~ '''ppl'''
  limit 1;

  if cname is null then
    raise notice 'clients.type has no CHECK constraint - ''tle'' is already accepted.';
    return;
  end if;

  select array_agg(distinct m.arr[1] order by m.arr[1])
    into vals
  from regexp_matches(cdef, '''([a-z_]+)''', 'g') as m(arr);

  if 'tle' = any(vals) then
    raise notice 'clients.type already allows ''tle'' - nothing to do.';
    return;
  end if;

  execute format('alter table public.clients drop constraint %I', cname);
  execute format(
    'alter table public.clients add constraint %I check (type = any (array[%s]))',
    cname,
    (select string_agg(quote_literal(v) || '::text', ', ' order by v)
       from unnest(array_append(vals, 'tle')) as v)
  );
  raise notice 'clients.type constraint % now allows: %', cname, array_append(vals, 'tle');
end $$;

create index if not exists idx_clients_type on public.clients (type);
