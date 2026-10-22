-- ════════════════════════════════════════════════════════════════════════════
-- HQ Workflows — schema + seed
-- Moves the Make.com workflow catalogue out of index.html so the deployed
-- HTML doesn't expose the tool stack. The Workflows tab on the HQ Fleet
-- panel reads from public.hq_workflows at runtime.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.hq_workflows (
  id          text PRIMARY KEY,
  icon        text NOT NULL DEFAULT '⚙️',
  name        text NOT NULL,
  tool        text NOT NULL,
  room        text NOT NULL,
  color       text NOT NULL DEFAULT '#4797ff',
  sort_order  int  NOT NULL DEFAULT 0,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hq_workflows_sort_idx
  ON public.hq_workflows (sort_order);

ALTER TABLE public.hq_workflows ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated read hq_workflows"  ON public.hq_workflows';
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated write hq_workflows" ON public.hq_workflows';
  EXECUTE 'DROP POLICY IF EXISTS "Service role hq_workflows"        ON public.hq_workflows';
END $$;

CREATE POLICY "Authenticated read hq_workflows"  ON public.hq_workflows FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write hq_workflows" ON public.hq_workflows FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role hq_workflows"        ON public.hq_workflows FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- ─── Seed (Bland → VAPI, Slack → Supabase) ──────────────────────────────────
INSERT INTO public.hq_workflows (id, icon, name, tool, room, color, sort_order) VALUES
  ('new-lead-sms',       '📥', 'New Lead → SMS in 60s', 'Make + Twilio',      'LEAD ENGINE', '#f472b6', 10),
  ('lead-voice-call',    '🎙️', 'Lead → Voice Call',     'Make + VAPI',        'LEAD ENGINE', '#fb923c', 20),
  ('quote-drafter',      '📄', 'Quote Drafter',         'Make + Claude AI',   'LEAD ENGINE', '#4797ff', 30),
  ('followup-cadence',   '🔁', 'Day 2/5/10 Follow-up',  'Make + CRM',         'LEAD ENGINE', '#a78bfa', 40),
  ('inbound-lead-crm',   '🎯', 'Inbound Lead → CRM',    'Make + GoHighLevel', 'SALES',       '#4797ff', 50),
  ('daily-reports',      '📊', 'Daily Client Reports',  'Make + Gmail',       'OPS',         '#60a5fa', 60),
  ('churn-risk-alert',   '⚠️', 'Churn Risk Alert',      'Make + Supabase',    'RETENTION',   '#f87171', 70),
  ('client-onboarding',  '🏗️', 'New Client Onboarding', 'Make + Notion',      'DELIVERY',    '#38bdf8', 80)
ON CONFLICT (id) DO UPDATE
  SET icon       = EXCLUDED.icon,
      name       = EXCLUDED.name,
      tool       = EXCLUDED.tool,
      room       = EXCLUDED.room,
      color      = EXCLUDED.color,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();
