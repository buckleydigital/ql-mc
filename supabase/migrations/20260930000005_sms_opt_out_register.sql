-- An SMS opt-out register, keyed by phone number - the same design as ql-hq's
-- sms_opt_outs (ql-hq migration 20260930000001).
--
-- Before this, an opt-out was a flag on a sales lead and nothing else, which
-- left ways to text someone who had replied STOP:
--
--   * a STOP given to ql-hq (the agency number Don answers) was mirrored here
--     as message text only - the lead's flag was never set;
--   * a STOP from a pay-per-lead contact, or an unknown number, was stored and
--     otherwise ignored;
--   * send-sms never checked pay-per-lead sends at all.
--
-- The register is the source of truth for this project (ql-mc is one sender:
-- the agency). send-sms asks sms_is_opted_out() before every send; every
-- STOP/START goes through sms_set_opt_out(), which also keeps leads.sms_opted_out
-- in step for the dashboard.

create or replace function public.norm_au_phone(p text)
returns text
language sql
immutable
as $$
  select case
    when p is null then null
    else (
      select case
        when v like '04%'  then '+61' || substr(v, 2)
        when v like '614%' then '+' || v
        when v like '61%'  then '+' || v
        else v
      end
      from (select regexp_replace(p, '[\s\-().]', '', 'g') as v) s
    )
  end
$$;

create table if not exists public.sms_opt_outs (
  phone       text        primary key,  -- E.164, via norm_au_phone()
  opted_out   boolean     not null default true,
  -- sms-reply, ql-hq, manual, backfill: where the latest change came from.
  source      text,
  updated_at  timestamptz not null default now()
);

alter table public.sms_opt_outs enable row level security;
alter table public.sms_opt_outs force  row level security;
revoke all on table public.sms_opt_outs from public, anon, authenticated;
grant all  on table public.sms_opt_outs to service_role;

insert into public.sms_opt_outs (phone, opted_out, source, updated_at)
select distinct on (public.norm_au_phone(phone))
       public.norm_au_phone(phone), true, 'backfill', coalesce(sms_opted_out_at, now())
  from public.leads
 where sms_opted_out = true and phone is not null
on conflict (phone) do nothing;

create or replace function public.sms_is_opted_out(p_phone text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
           select 1 from public.sms_opt_outs o
            where o.phone = public.norm_au_phone(p_phone) and o.opted_out
         )
      or exists (
           select 1 from public.leads l
            where l.sms_opted_out = true
              and public.norm_au_phone(l.phone) = public.norm_au_phone(p_phone)
         )
$$;

create or replace function public.sms_set_opt_out(p_phone text, p_opted_out boolean, p_source text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := public.norm_au_phone(p_phone);
begin
  if v_phone is null or v_phone = '' then
    return;
  end if;
  insert into public.sms_opt_outs (phone, opted_out, source, updated_at)
  values (v_phone, p_opted_out, p_source, now())
  on conflict (phone)
  do update set opted_out = excluded.opted_out, source = excluded.source, updated_at = now();

  update public.leads
     set sms_opted_out    = p_opted_out,
         sms_opted_out_at = case when p_opted_out then now() else null end
   where public.norm_au_phone(phone) = v_phone
     and sms_opted_out is distinct from p_opted_out;
end;
$$;

revoke all on function public.sms_is_opted_out(text)                from public, anon, authenticated;
revoke all on function public.sms_set_opt_out(text, boolean, text)  from public, anon, authenticated;
grant execute on function public.sms_is_opted_out(text)               to service_role;
grant execute on function public.sms_set_opt_out(text, boolean, text) to service_role;
