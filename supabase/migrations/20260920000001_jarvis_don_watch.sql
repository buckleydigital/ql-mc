-- Let Jarvis notice when Don is off while leads are waiting.
--
-- Don's config lives in ql-hq. Jarvis's watchers are SQL running here, and a
-- SELECT cannot make an HTTP call to another project - so he could answer "is
-- Don on" when asked and never once volunteer that Don had been off for a week
-- while people were texting in.
--
-- Three columns hold a copy of Don's state, refreshed by jarvis-notify on each
-- heartbeat and written through immediately when the agent modal saves. Same
-- arrangement as fulfilment, which ql-hq pushes here for the same reason.
--
-- Applied to production before being written down; this file is so a fresh
-- database matches the live one.
alter table public.business_settings
  add column if not exists don_enabled   boolean,
  add column if not exists don_active    boolean,
  add column if not exists don_synced_at timestamptz;

comment on column public.business_settings.don_enabled is
  'Mirror of ql-hq sms_agent_config.auto_reply for the agency''s own agent. Null means never synced.';
comment on column public.business_settings.don_active is
  'Mirror of ql-hq sms_agent_config.is_active. False means the config is not even attached to the inbound path, so switching auto_reply on alone would not wake him.';
comment on column public.business_settings.don_synced_at is
  'When the mirror was last refreshed. A stale value means the sync is failing, which the watcher treats as not-knowing rather than as "off".';

-- The don_off branch added to jarvis_scan() is applied in the same migration
-- in production. See the function body: it fires only when the mirror is fresh
-- (under 2 hours), says Don is off, AND at least one lead has texted in within
-- 72 hours. Off on its own is a deliberate choice and not worth interrupting
-- anyone over; off while people are waiting is what quietly costs money.
