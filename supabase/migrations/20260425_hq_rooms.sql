-- ════════════════════════════════════════════════════════════════════════════
-- HQ Rooms — schema + seed
-- Moves the HQ Fleet room/agent/human catalogue out of index.html so the
-- deployed HTML doesn't expose internal team structure or naming. The HQ
-- Fleet panel reads from public.hq_rooms at runtime.
--
-- One table is used for both kinds of rooms; the `kind` column distinguishes
-- AI agents ('agent') from real people ('human'). The `agents` jsonb column
-- holds the list of sprites in the room (each item: {id, name, role, color}).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.hq_rooms (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('agent','human')),
  name        text NOT NULL,
  bg          text NOT NULL,
  border      text NOT NULL,
  label       text NOT NULL,
  decor       jsonb NOT NULL DEFAULT '{}'::jsonb,
  agents      jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order  int  NOT NULL DEFAULT 0,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hq_rooms_kind_sort_idx
  ON public.hq_rooms (kind, sort_order);

ALTER TABLE public.hq_rooms ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated read hq_rooms"  ON public.hq_rooms';
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated write hq_rooms" ON public.hq_rooms';
  EXECUTE 'DROP POLICY IF EXISTS "Service role hq_rooms"        ON public.hq_rooms';
END $$;

CREATE POLICY "Authenticated read hq_rooms"  ON public.hq_rooms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write hq_rooms" ON public.hq_rooms FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role hq_rooms"        ON public.hq_rooms FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- ─── Seed: AI agent rooms ───────────────────────────────────────────────────
INSERT INTO public.hq_rooms (id, kind, name, bg, border, label, decor, agents, sort_order) VALUES
  ('sales', 'agent', '🏢 SALES', '#070f07', '#4797ff', '#4797ff',
    '{"window":true,"plant":true,"desks":true,"monitors":true,"tag":"BULLPEN"}'::jsonb,
    '[{"id":"prospector","name":"Prospector","role":"Outbound","color":"#4797ff"},
      {"id":"qualifier","name":"Qualifier","role":"Inbound","color":"#a78bfa"},
      {"id":"closer","name":"Closer","role":"Proposals","color":"#fb923c"}]'::jsonb,
    10),
  ('delivery', 'agent', '⚙️ DELIVERY', '#070a14', '#38bdf8', '#60a5fa',
    '{"window":true,"plant":false,"desks":true,"monitors":true,"tag":"BUILD BAY"}'::jsonb,
    '[{"id":"builder","name":"Builder","role":"Onboarding","color":"#38bdf8"},
      {"id":"adbot","name":"Adbot","role":"Meta/Google","color":"#facc15"},
      {"id":"landingpg","name":"LandingPg","role":"Pages","color":"#4797ff"}]'::jsonb,
    20),
  ('leadengine', 'agent', '📲 LEAD ENGINE', '#140714', '#f472b6', '#f472b6',
    '{"window":false,"plant":true,"desks":true,"monitors":true,"tag":"CALL CENTRE"}'::jsonb,
    '[{"id":"smsagent","name":"SMSAgent","role":"Respond","color":"#f472b6"},
      {"id":"voicebot","name":"VoiceBot","role":"Calls","color":"#fb923c"},
      {"id":"quoter","name":"Quoter","role":"Quotes","color":"#4797ff"},
      {"id":"chaser","name":"Chaser","role":"Follow-up","color":"#a78bfa"}]'::jsonb,
    30),
  ('retention', 'agent', '🛡️ RETENTION', '#071410', '#4797ff', '#4797ff',
    '{"window":true,"plant":true,"desks":true,"monitors":true,"tag":"CARE TEAM"}'::jsonb,
    '[{"id":"pulsecheck","name":"PulseCheck","role":"Health","color":"#4797ff"},
      {"id":"churnbot","name":"ChurnBot","role":"At-risk","color":"#f87171"},
      {"id":"reporter","name":"Reporter","role":"Reports","color":"#60a5fa"}]'::jsonb,
    40),
  ('ops', 'agent', '🧠 OPS', '#0f0714', '#a78bfa', '#a78bfa',
    '{"window":true,"plant":true,"desks":true,"monitors":true,"tag":"BACK OFFICE"}'::jsonb,
    '[{"id":"inbox","name":"Inbox","role":"Comms","color":"#facc15"},
      {"id":"bookkeeper","name":"Bookkeeper","role":"Finance","color":"#a78bfa"},
      {"id":"datasyncer","name":"DataSyncer","role":"CRM","color":"#38bdf8"}]'::jsonb,
    50)
ON CONFLICT (id) DO UPDATE
  SET kind       = EXCLUDED.kind,
      name       = EXCLUDED.name,
      bg         = EXCLUDED.bg,
      border     = EXCLUDED.border,
      label      = EXCLUDED.label,
      decor      = EXCLUDED.decor,
      agents     = EXCLUDED.agents,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();

-- ─── Seed: Human rooms ──────────────────────────────────────────────────────
INSERT INTO public.hq_rooms (id, kind, name, bg, border, label, decor, agents, sort_order) VALUES
  ('executive', 'human', '👔 EXECUTIVE', '#0a0a14', '#facc15', '#facc15',
    '{"window":true,"plant":true,"desks":true,"monitors":true,"tag":"C-SUITE"}'::jsonb,
    '[{"id":"h-ceo","name":"CEO","role":"Chief Exec","color":"#facc15"}]'::jsonb,
    10),
  ('sales-floor', 'human', '💼 SALES FLOOR', '#070f07', '#4797ff', '#4797ff',
    '{"window":true,"plant":true,"desks":true,"monitors":true,"tag":"REVENUE"}'::jsonb,
    '[{"id":"h-sales-1","name":"Sales Rep 1","role":"Account Exec","color":"#4797ff"},
      {"id":"h-sales-2","name":"Sales Rep 2","role":"Account Exec","color":"#60a5fa"}]'::jsonb,
    20),
  ('support', 'human', '🎧 CUSTOMER SUPPORT', '#071410', '#34d399', '#34d399',
    '{"window":false,"plant":true,"desks":true,"monitors":true,"tag":"HELPDESK"}'::jsonb,
    '[{"id":"h-cs-1","name":"CS Rep 1","role":"Support","color":"#34d399"},
      {"id":"h-cs-2","name":"CS Rep 2","role":"Support","color":"#22c55e"}]'::jsonb,
    30)
ON CONFLICT (id) DO UPDATE
  SET kind       = EXCLUDED.kind,
      name       = EXCLUDED.name,
      bg         = EXCLUDED.bg,
      border     = EXCLUDED.border,
      label      = EXCLUDED.label,
      decor      = EXCLUDED.decor,
      agents     = EXCLUDED.agents,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();
