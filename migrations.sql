-- QL Mission Control — Required SQL Migrations
-- Run these in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- ── 1. PPL CLIENTS: Add leads_delivered and total_leads_purchased ──
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS leads_delivered       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_leads_purchased integer NOT NULL DEFAULT 0;

-- ── 2. TASKS: Add linked_ref and linked_name columns ──
-- These allow tasks to be linked to any lead or client record.
-- linked_ref format: "lead:<uuid>" or "client:<uuid>"
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS linked_ref  text,
  ADD COLUMN IF NOT EXISTS linked_name text;

-- ── 3. PPL LEAD AREAS: Create table for Google Maps area tracking ──
CREATE TABLE IF NOT EXISTS public.ppl_lead_areas (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid        REFERENCES public.clients(id) ON DELETE CASCADE,
  label       text        NOT NULL,
  volume      integer     NOT NULL DEFAULT 0,
  geo_json    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 4. MANAGED ADS PIPELINE: Migrate existing records to 3-stage model ──
-- Previously: lead, qualified, onboarding, active, paused, churned
-- Now: active, paused, churned
UPDATE public.clients
  SET stage = 'active'
  WHERE type = 'managed'
    AND stage IN ('lead', 'qualified', 'onboarding');

-- ── 5. CHAT MEMORY: Ensure agent column supports 'sales' value ──
-- ALTER TABLE public.chat_memory DROP CONSTRAINT IF EXISTS chat_memory_agent_check;
-- ALTER TABLE public.chat_memory
--   ADD CONSTRAINT chat_memory_agent_check
--   CHECK (agent IN ('marketing','finance','operations','strategy','sales','docs'));

-- ── 6. AGENT FILES: Ensure 'docs' agent key is supported ──
-- Same as above — if agent_files has a CHECK on the agent column:
-- ALTER TABLE public.agent_files DROP CONSTRAINT IF EXISTS agent_files_agent_check;
-- ALTER TABLE public.agent_files
--   ADD CONSTRAINT agent_files_agent_check
--   CHECK (agent IN ('marketing','finance','operations','strategy','sales','docs'));

-- ── 7. VERIFICATION ──
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'clients'
  AND column_name IN ('leads_delivered','total_leads_purchased');

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'tasks'
  AND column_name IN ('linked_ref','linked_name');

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'ppl_lead_areas';

-- ============================================================
-- ── ROW LEVEL SECURITY (RLS) — SECURITY FIX ─────────────
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

-- ppl_lead_areas
ALTER TABLE public.ppl_lead_areas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_ppl_lead_areas" ON public.ppl_lead_areas;
CREATE POLICY "auth_all_ppl_lead_areas" ON public.ppl_lead_areas FOR ALL TO authenticated USING (true) WITH CHECK (true);

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
