-- ════════════════════════════════════════════════════════════════════════════
-- Drop Agent Fleet — remove all fleet-only tables and their dependent objects
--
-- Tables dropped:
--   agents        — live status / Fleet Map sprites
--   agent_runs    — automation scenario start/finish log
--   hq_rooms      — Fleet Map room/agent catalogue
--   hq_workflows  — Tech Stack entry catalogue
--
-- Tables intentionally kept (still used by Master Brain chat and Files panel):
--   agent_config  — agent personas referenced by the chat proxy
--   agent_files   — markdown files used by the files editor and chat
--   chat_memory   — persisted per-user chat history
-- ════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS public.agents       CASCADE;
DROP TABLE IF EXISTS public.agent_runs   CASCADE;
DROP TABLE IF EXISTS public.hq_rooms     CASCADE;
DROP TABLE IF EXISTS public.hq_workflows CASCADE;
