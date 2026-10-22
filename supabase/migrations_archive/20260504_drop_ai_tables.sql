-- ════════════════════════════════════════════════════════════════════════════
-- Drop AI tables — Master Brain chat and JARVIS voice agent have been removed
-- from the dashboard. The tables that backed them are no longer referenced by
-- the app.
--
-- Tables dropped:
--   chat_memory   — persisted per-user chat / VAPI session transcripts
--   agent_config  — agent personas referenced by the chat proxy
--
-- Tables intentionally kept:
--   agent_files   — still used by the Files panel (templates/scripts under
--                   agent='docs'). The chat-only rows for other agents are
--                   left untouched; they are simply no longer read.
-- ════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS public.chat_memory CASCADE;
DROP TABLE IF EXISTS public.agent_config CASCADE;
