-- QL Mission Control — Required SQL Migrations
-- Run these in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- ── 1. PPL CLIENTS: Add leads_delivered and total_leads_purchased ──
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS leads_delivered       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_leads_purchased integer NOT NULL DEFAULT 0;

-- ── 1b. PPL CLIENTS: Add leads_scrubbed ──
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS leads_scrubbed integer NOT NULL DEFAULT 0;

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

-- ── 7. APP SETTINGS: Secure key/value store for server-side secrets ──
-- Store secrets like GOOGLE_MAPS_KEY here; read via Edge Function only.
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- No direct client access — service role only (no RLS policy grants to authenticated)
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
-- Intentionally no authenticated policy: only the Edge Function (service role) can read this.

-- Insert your Google Maps key (run once, update as needed):
-- INSERT INTO public.app_settings (key, value)
-- VALUES ('google_maps_key', 'YOUR_ACTUAL_KEY_HERE')
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ── 8. PPL LEAD DISTRIBUTION: Add delivery config columns to clients ──
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS postcodes            text[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS delivery_method      text        DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS delivery_email       text,
  ADD COLUMN IF NOT EXISTS delivery_phone       text,
  ADD COLUMN IF NOT EXISTS custom_fields        jsonb       DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_lead_delivered_at timestamptz;

-- ── 9. SOLAR LEADS: Incoming leads from Make.com webhook ──
CREATE TABLE IF NOT EXISTS public.solar_leads (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Contact info (from ad form / webhook)
  name                text        NOT NULL,
  email               text,
  phone               text,
  postcode            text        NOT NULL,
  address             text,
  suburb              text,
  state               text,
  -- Solar-specific fields
  property_type       text,       -- 'residential', 'commercial'
  roof_type           text,
  monthly_bill        numeric,
  system_size         text,
  interested_in       text,       -- 'solar', 'battery', 'both'
  -- Flexible extra fields from the ad form (Make maps these in)
  custom_data         jsonb       DEFAULT '{}',
  -- Distribution / delivery
  assigned_client_id  uuid        REFERENCES public.clients(id) ON DELETE SET NULL,
  assigned_at         timestamptz,
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','assigned','delivered','failed','scrubbed')),
  delivery_method     text,
  delivered_at        timestamptz,
  delivery_error      text,
  -- Source tracking
  source              text        DEFAULT 'make',
  -- Timestamps
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ── 10. SOLAR LEADS: RLS ──
ALTER TABLE public.solar_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_solar_leads" ON public.solar_leads;
CREATE POLICY "auth_all_solar_leads" ON public.solar_leads FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 11. SOLAR LEADS: Atomic assignment function for Make.com ──
-- Called by Make after inserting the lead; atomically finds the right
-- client (active, covers the postcode, longest since last delivery),
-- increments leads_delivered, and returns delivery details.
CREATE OR REPLACE FUNCTION public.assign_solar_lead(
  p_lead_id  uuid,
  p_postcode text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client record;
BEGIN
  -- Atomically lock the next eligible client using SKIP LOCKED so
  -- concurrent Make executions never double-assign the same client.
  SELECT
    c.id,
    c.company_name,
    c.delivery_method,
    c.delivery_email,
    c.delivery_phone,
    c.custom_fields
  INTO v_client
  FROM public.clients c
  WHERE c.type    = 'ppl'
    AND c.stage   = 'active_client'
    AND (c.leads_delivered + COALESCE(c.leads_scrubbed, 0)) < c.total_leads_purchased
    AND p_postcode = ANY(c.postcodes)
  ORDER BY c.last_lead_delivered_at ASC NULLS FIRST
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_client.id IS NULL THEN
    RETURN jsonb_build_object(
      'assigned', false,
      'reason',   'no_matching_client'
    );
  END IF;

  -- Increment counter and record the timestamp
  UPDATE public.clients
  SET
    leads_delivered         = leads_delivered + 1,
    last_lead_delivered_at  = now(),
    updated_at              = now()
  WHERE id = v_client.id;

  -- Mark the lead as assigned
  UPDATE public.solar_leads
  SET
    assigned_client_id = v_client.id,
    assigned_at        = now(),
    status             = 'assigned',
    delivery_method    = v_client.delivery_method,
    updated_at         = now()
  WHERE id = p_lead_id;

  RETURN jsonb_build_object(
    'assigned',        true,
    'client_id',       v_client.id,
    'company_name',    v_client.company_name,
    'delivery_method', v_client.delivery_method,
    'delivery_email',  v_client.delivery_email,
    'delivery_phone',  v_client.delivery_phone,
    'custom_fields',   COALESCE(v_client.custom_fields, '{}'::jsonb)
  );
END;
$$;

-- ── 12. VERIFICATION ──
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
