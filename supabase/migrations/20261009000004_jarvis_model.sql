-- Which Claude model Jarvis thinks with, chosen in Jarvis settings.
--
-- Null means the default (jarvis-chat's JARVIS_MODEL secret, else Claude
-- Opus 5.5). Only models that take exactly the request jarvis-chat sends are
-- allowed: the same thinking, effort, refusal-fallback and web-tool settings.
-- jarvis-chat checks the same list, so a value that slipped past this could
-- still never reach the API.
alter table public.business_settings
  add column if not exists jarvis_model text;

alter table public.business_settings
  drop constraint if exists business_settings_jarvis_model_check;
alter table public.business_settings
  add constraint business_settings_jarvis_model_check
  check (jarvis_model is null or jarvis_model in ('claude-opus-5-5', 'claude-sonnet-5-5'));
