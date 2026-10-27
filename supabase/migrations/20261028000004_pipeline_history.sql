-- The sales pipeline only knew each lead's current stage. Funnel metrics over
-- a chosen timeframe need to know when things happened:
--
--   lead_stage_history   every move between stages, with when and who
--   leads.offer_sent_at  first offer: the 2.5K or 5K offer email, or the
--                        move to Proposal, whichever came first
--   leads.won_at         when it was moved to Closed Won (cleared if moved off)
--   leads.lost_at        when it was moved to Closed Lost (cleared if moved off)
--
-- Contactable stays the yes/no it already is. A lead at Proposal or Won was
-- reached, so it is contactable, and a won lead counts as offered.

create table if not exists public.lead_stage_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  from_stage text,
  to_stage text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  source text not null default 'live'   -- live | backfill | sheet
);
create index if not exists lead_stage_history_lead on public.lead_stage_history (lead_id, changed_at);
create index if not exists lead_stage_history_at on public.lead_stage_history (changed_at);
alter table public.lead_stage_history enable row level security;
-- Readable wherever the lead is: the same rule as leads, through it.
create policy lead_stage_history_read on public.lead_stage_history for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));

alter table public.leads
  add column if not exists offer_sent_at timestamptz,
  add column if not exists won_at timestamptz,
  add column if not exists lost_at timestamptz;

create or replace function public.leads_track_milestones()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  moved boolean := tg_op = 'INSERT' or new.stage is distinct from old.stage;
begin
  if moved then
    new.won_at  := case when new.stage = 'closed_won'  then coalesce(case when tg_op = 'UPDATE' and old.stage = 'closed_won' then old.won_at end, now()) end;
    new.lost_at := case when new.stage = 'closed_lost' then coalesce(case when tg_op = 'UPDATE' and old.stage = 'closed_lost' then old.lost_at end, now()) end;
  end if;
  new.offer_sent_at := coalesce(
    new.offer_sent_at,
    least(new.info_sent_at, new.info_5k_sent_at),
    case when new.stage in ('proposal', 'closed_won') then now() end);
  if new.stage in ('call_back', 'proposal', 'closed_won') and new.contactable is null then
    new.contactable := true;
  end if;
  return new;
end $$;

drop trigger if exists leads_track_milestones on public.leads;
create trigger leads_track_milestones
  before insert or update of stage, info_sent_at, info_5k_sent_at on public.leads
  for each row execute function public.leads_track_milestones();

create or replace function public.leads_log_stage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    insert into lead_stage_history (lead_id, from_stage, to_stage, changed_by)
    values (new.id, case when tg_op = 'UPDATE' then old.stage end, new.stage, auth.uid());
  end if;
  return null;
end $$;
revoke all on function public.leads_log_stage() from public, anon, authenticated;

drop trigger if exists leads_log_stage on public.leads;
create trigger leads_log_stage
  after insert or update of stage on public.leads
  for each row execute function public.leads_log_stage();

-- ── Backfill from what the database already knows ──────────────────────────
-- Offers: the offer emails on the lead, or in the sales email log.
update public.leads l
   set offer_sent_at = x.first_offer
  from (
    select l2.id, least(l2.info_sent_at, l2.info_5k_sent_at,
                        (select min(e.sent_at) from sales_email_log e where e.lead_id = l2.id and e.kind in ('info', 'info_5k'))) as first_offer
      from public.leads l2
  ) x
 where x.id = l.id and l.offer_sent_at is null and x.first_offer is not null;

-- Won and lost: the last stage change, where it was recorded.
update public.leads set won_at  = stage_changed_at where stage = 'closed_won'  and won_at  is null and stage_changed_at is not null;
update public.leads set lost_at = stage_changed_at where stage = 'closed_lost' and lost_at is null and stage_changed_at is not null;

-- History: every lead arrived when it was created; its current stage from
-- when it was last moved, where that's known. The rest comes from the sheet.
insert into public.lead_stage_history (lead_id, from_stage, to_stage, changed_at, source)
select id, null, 'new_lead', created_at, 'backfill' from public.leads
 where not exists (select 1 from public.lead_stage_history h where h.lead_id = leads.id);
insert into public.lead_stage_history (lead_id, from_stage, to_stage, changed_at, source)
select id, 'new_lead', stage, stage_changed_at, 'backfill' from public.leads
 where stage <> 'new_lead' and stage_changed_at is not null and stage_changed_at > created_at
   and not exists (select 1 from public.lead_stage_history h where h.lead_id = leads.id and h.to_stage = leads.stage);
