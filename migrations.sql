-- QL Mission Control — Required SQL Migrations
-- Run these in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- ── 1. PPL CLIENTS: Add leads_delivered and total_leads_purchased ──
-- These track how many leads have actually been sent to each client
-- and how many they have purchased in total (may differ from delivered
-- if some are credited/rejected).

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS leads_delivered       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_leads_purchased integer NOT NULL DEFAULT 0;

-- ── 2. CHAT MEMORY: Ensure agent column supports 'sales' value ──
-- If you have a CHECK constraint on the agent column, update it.
-- Run the query below to check first:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'chat_memory'::regclass AND contype = 'c';
--
-- If a constraint exists, drop and recreate it to include 'sales':
-- ALTER TABLE public.chat_memory DROP CONSTRAINT IF EXISTS chat_memory_agent_check;
-- ALTER TABLE public.chat_memory
--   ADD CONSTRAINT chat_memory_agent_check
--   CHECK (agent IN ('marketing','finance','operations','strategy','sales'));

-- ── 3. AGENT FILES: Ensure 'sales' agent key is supported ──
-- Same as above — if agent_files has a CHECK on the agent column:
-- ALTER TABLE public.agent_files DROP CONSTRAINT IF EXISTS agent_files_agent_check;
-- ALTER TABLE public.agent_files
--   ADD CONSTRAINT agent_files_agent_check
--   CHECK (agent IN ('marketing','finance','operations','strategy','sales'));

-- ── 4. VERIFICATION ──
-- After running, verify with:
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'clients'
  AND column_name IN ('leads_delivered','total_leads_purchased');
