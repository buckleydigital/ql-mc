-- One place to see everything Jarvis has done.
--
-- Everything was already being recorded - it was just spread across four tables
-- with no way to read it as a sequence. jarvis_events knows what he spotted,
-- jarvis_notifications what he sent you, jarvis_messages what you said back and
-- what he answered, and sales_email_log what actually reached a client. Read
-- separately they are four logs that each tell a quarter of the story.
--
-- So this is a chronological union of the four, newest first. It is a read of
-- existing rows and stores nothing new: there is no second copy of the truth to
-- drift out of step with the first.

-- The one genuinely missing fact. A follow-up Jarvis sends is written under the
-- owner's user id - that is deliberate, so the reply-to and the log name a real
-- person - but it makes his sends indistinguishable from the owner sending the
-- same email by hand from the pipeline. For an action log that is the whole
-- point, so the bridge now says so.
--
-- Null means a person clicked the button. Backfilling is not possible and not
-- attempted: nothing recorded before this column existed knows the answer, and
-- guessing would put invented facts in an audit log.
alter table public.sales_email_log
  add column if not exists via text;

comment on column public.sales_email_log.via is
  'Null for a send from the dashboard by a signed-in person; ''jarvis'' for one authorised by text or call through the Jarvis bridge.';

-- Same shape as jarvis_status: SECURITY DEFINER because the underlying tables
-- are revoked from authenticated and force RLS with no policies, with the
-- authorisation written into the body rather than left to the grant.
--
-- Unlike jarvis_status this returns actual rows, not counts - a log that will
-- not show you the log is not a log. That is safe for the same reason the
-- settings panel is: the gate below admits only the people who run the
-- business, and account_type comes from the signed JWT so a rep cannot claim
-- otherwise.
create or replace function public.jarvis_action_log(p_limit int default 80)
returns table (
  at      timestamptz,
  kind    text,
  subject text,
  detail  text,
  status  text,
  ref     jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
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

  -- Clamped rather than trusted: this is reachable over PostgREST with any
  -- argument, and an unbounded limit is a way to make the database do a lot of
  -- work on request.
  lim := least(greatest(coalesce(p_limit, 80), 1), 500);

  return query
  with log_rows as (
    -- What he noticed. The origin of everything else, so it belongs in the same
    -- sequence rather than in a separate "what is open" list.
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

    -- What he sent you. Failures included on purpose: an alert that did not
    -- arrive is the single most important thing this log can tell you, and it
    -- is invisible everywhere else.
    select n.created_at,
           case when n.channel = 'call' then 'called_you' else 'texted_you' end,
           null,
           n.body,
           n.status,
           jsonb_strip_nulls(jsonb_build_object('twilio_sid', n.twilio_sid, 'error', n.error))
    from public.jarvis_notifications n

    union all

    -- The conversation, both halves.
    select m.created_at,
           case when m.direction = 'inbound' then 'you_said' else 'he_replied' end,
           null,
           m.body,
           case when m.error is not null then 'failed' else 'sent' end,
           jsonb_strip_nulls(jsonb_build_object('twilio_sid', m.twilio_sid, 'error', m.error))
    from public.jarvis_messages m

    union all

    -- What actually left the building. The rows that reached a real client, so
    -- the lead is named rather than left as an id.
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
end $$;

revoke all on function public.jarvis_action_log(int) from public;
grant execute on function public.jarvis_action_log(int) to authenticated, service_role;
