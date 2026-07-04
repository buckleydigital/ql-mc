-- PPL Campaigns: manually tracked campaign records with status lifecycle
create table if not exists ppl_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active', -- active, paused, nuked
  niche text,
  area text,
  meta_campaign_id uuid references meta_campaigns(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ppl_campaigns_status_idx on ppl_campaigns(status);
alter table ppl_campaigns enable row level security;
create policy "Allow all for authenticated" on ppl_campaigns for all using (auth.role() = 'authenticated');

-- PPL Campaign Action Log (PCAL): tracks every change/action on a campaign
create table if not exists ppl_campaign_action_log (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references ppl_campaigns(id) on delete cascade,
  action_type text not null default 'note', -- status_change, budget_change, targeting_change, creative_change, note, other
  details text,
  logged_at timestamptz not null default now()
);
create index if not exists pcal_campaign_id_idx on ppl_campaign_action_log(campaign_id);
alter table ppl_campaign_action_log enable row level security;
create policy "Allow all for authenticated" on ppl_campaign_action_log for all using (auth.role() = 'authenticated');
