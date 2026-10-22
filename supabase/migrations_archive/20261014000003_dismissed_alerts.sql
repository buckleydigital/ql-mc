-- Alerts cleared from the bell, shared by everyone on the team and kept
-- across browsers and devices. key is the alert's key from buildAlertItems in
-- index.html (for example report:<client id> or invoice:<client id>:<due date>),
-- so clearing one alert never hides a different one.

create table if not exists public.dismissed_alerts (
  key          text primary key,
  dismissed_at timestamptz not null default now(),
  dismissed_by uuid default auth.uid()
);

alter table public.dismissed_alerts enable row level security;

create policy dismissed_alerts_full_users on public.dismissed_alerts for all to authenticated
  using (not public.is_sales_rep())
  with check (not public.is_sales_rep());
