-- Files screen: a template or script can be renamed. The filename stays the
-- key its content is saved under; these are only what the list shows.
-- Null means the built-in name and description.
alter table public.agent_files add column if not exists title       text;
alter table public.agent_files add column if not exists description text;
