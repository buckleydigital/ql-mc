-- Action log for PPL and Managed Advertising clients
create table if not exists client_action_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  action_type text not null default 'note', -- call, email, meeting, note, other
  notes text,
  logged_at timestamptz not null default now()
);
create index if not exists client_action_log_client_id_idx on client_action_log(client_id);
alter table client_action_log enable row level security;
create policy "Allow all for authenticated" on client_action_log for all using (auth.role() = 'authenticated');

-- Contact log for Sales Pipeline (CRM) leads
create table if not exists lead_contact_log (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  contact_type text not null default 'call', -- call, email, sms, meeting, other
  outcome text, -- positive, neutral, negative, no_answer
  notes text,
  contacted_at timestamptz not null default now()
);
create index if not exists lead_contact_log_lead_id_idx on lead_contact_log(lead_id);
alter table lead_contact_log enable row level security;
create policy "Allow all for authenticated" on lead_contact_log for all using (auth.role() = 'authenticated');
