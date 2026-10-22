-- Jarvis notifies in the dashboard, not by text.
--
-- jarvis-notify used to text the owner a summary of new alerts and the result
-- of each scheduled job. It now writes the same message to
-- jarvis_notifications with channel 'panel', and the Jarvis panel shows the
-- unread ones. No Twilio, so no SMS credits, and no quiet hours or daily cap:
-- an unread note waits quietly until it is opened.

alter table public.jarvis_notifications add column if not exists read_at timestamptz;
create index if not exists jarvis_notifications_unread_idx
  on public.jarvis_notifications (created_at desc) where channel = 'panel' and read_at is null;

-- What he has to tell you, newest first.
create or replace function public.jarvis_inbox(p_limit int default 20)
returns table (id uuid, tier text, body text, created_at timestamptz, read_at timestamptz, unread bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  return query
    select n.id, n.tier, n.body, n.created_at, n.read_at,
           (select count(*) from public.jarvis_notifications u where u.channel = 'panel' and u.read_at is null)
      from public.jarvis_notifications n
     where n.channel = 'panel'
     order by n.created_at desc
     limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

-- Marks the given notes read, or all of them when p_ids is null.
create or replace function public.jarvis_inbox_read(p_ids uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.jarvis_assert_operator();
  update public.jarvis_notifications
     set read_at = now()
   where channel = 'panel' and read_at is null
     and (p_ids is null or id = any (p_ids));
end;
$$;

revoke all on function public.jarvis_inbox(int)          from public, anon;
revoke all on function public.jarvis_inbox_read(uuid[])  from public, anon;
grant execute on function public.jarvis_inbox(int)         to authenticated;
grant execute on function public.jarvis_inbox_read(uuid[]) to authenticated;

-- The activity log: a panel note is "told you", not "texted you".
create or replace function public.jarvis_action_log(p_limit integer default 80)
returns table(at timestamptz, kind text, subject text, detail text, status text, ref jsonb)
language plpgsql stable security definer set search_path to 'public' as $function$
declare
  acct text;
  lim  int;
begin
  acct := coalesce(auth.jwt() -> 'app_metadata' ->> 'account_type', '');
  if acct in ('sales_rep', 'lead_buyer') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if auth.jwt() is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  lim := least(greatest(coalesce(p_limit, 80), 1), 500);

  return query
  with log_rows as (
    select e.first_seen_at as at,
           'spotted'::text as kind,
           e.subject,
           e.kind || case when e.tier = 'urgent' then ' (urgent)' else '' end as detail,
           case when e.resolved_at is not null then 'resolved' else 'open' end as status,
           jsonb_strip_nulls(jsonb_build_object(
             'lead_id',   e.payload ->> 'lead_id',
             'client_id', e.payload ->> 'client_id',
             'days',      e.payload ->> 'days'
           )) as ref
    from public.jarvis_events e

    union all

    select n.created_at,
           case n.channel when 'call' then 'called_you' when 'panel' then 'told_you' else 'texted_you' end,
           null,
           n.body,
           n.status,
           jsonb_strip_nulls(jsonb_build_object('twilio_sid', n.twilio_sid, 'error', n.error))
    from public.jarvis_notifications n

    union all

    select m.created_at,
           case when m.direction = 'inbound' then 'you_said' else 'he_replied' end,
           null,
           m.body,
           case when m.error is not null then 'failed' else 'sent' end,
           jsonb_strip_nulls(jsonb_build_object('twilio_sid', m.twilio_sid, 'error', m.error))
    from public.jarvis_messages m

    union all

    select l.sent_at,
           'emailed_client',
           coalesce(nullif(ld.company, ''), ld.name, l.to_email),
           l.subject,
           'sent',
           jsonb_strip_nulls(jsonb_build_object(
             'lead_id', l.lead_id::text,
             'to',      l.to_email,
             'kind',    l.kind
           ))
    from public.sales_email_log l
    left join public.leads ld on ld.id = l.lead_id
    where l.via = 'jarvis'
  )
  select log_rows.at, log_rows.kind, log_rows.subject, log_rows.detail, log_rows.status, log_rows.ref
  from log_rows
  order by log_rows.at desc
  limit lim;
end $function$;
