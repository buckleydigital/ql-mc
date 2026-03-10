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

-- ============================================================
-- ── 5. ROW LEVEL SECURITY (RLS) — SECURITY FIX ─────────────
-- Enable RLS on every table so the public anon/publishable key
-- cannot read data from unauthenticated requests.
-- Authenticated users (logged-in operators) get full access.
-- chat_memory is scoped per-user via auth.uid().
-- daily_snapshots is read-only (written by Make.com service role).
-- ============================================================

-- tasks
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_tasks" ON public.tasks;
CREATE POLICY "auth_all_tasks" ON public.tasks FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- flagged_emails
ALTER TABLE public.flagged_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_flagged_emails" ON public.flagged_emails;
CREATE POLICY "auth_all_flagged_emails" ON public.flagged_emails FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- leads
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_leads" ON public.leads;
CREATE POLICY "auth_all_leads" ON public.leads FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- clients
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_clients" ON public.clients;
CREATE POLICY "auth_all_clients" ON public.clients FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- revenue
ALTER TABLE public.revenue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_revenue" ON public.revenue;
CREATE POLICY "auth_all_revenue" ON public.revenue FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- expenses
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_expenses" ON public.expenses;
CREATE POLICY "auth_all_expenses" ON public.expenses FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- subscriptions
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_subscriptions" ON public.subscriptions;
CREATE POLICY "auth_all_subscriptions" ON public.subscriptions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ad_spend_daily
ALTER TABLE public.ad_spend_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_ad_spend_daily" ON public.ad_spend_daily;
CREATE POLICY "auth_all_ad_spend_daily" ON public.ad_spend_daily FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- agent_files
ALTER TABLE public.agent_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_agent_files" ON public.agent_files;
CREATE POLICY "auth_all_agent_files" ON public.agent_files FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- chat_memory — per-user isolation
ALTER TABLE public.chat_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_own_chat_memory" ON public.chat_memory;
CREATE POLICY "auth_own_chat_memory" ON public.chat_memory FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- daily_snapshots — read-only for authenticated users (Make.com writes via service role)
ALTER TABLE public.daily_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_read_daily_snapshots" ON public.daily_snapshots;
CREATE POLICY "auth_read_daily_snapshots" ON public.daily_snapshots FOR SELECT TO authenticated USING (true);

-- Verify RLS is ON for all tables:
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
