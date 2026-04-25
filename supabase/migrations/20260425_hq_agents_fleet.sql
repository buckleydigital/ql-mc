-- ════════════════════════════════════════════════════════════════════════════
-- HQ Agent Fleet — schema + seed
-- Adds the 15 operational agents from bake-in.html so the Agent Fleet panel
-- and Agent Chat list in index.html are fully wired up.
--
-- Tables (created IF NOT EXISTS so this is safe on existing projects):
--   agent_config  — persona/name/role/emoji/intro for each agent (used by chat)
--   agent_files   — markdown config files per agent (Agents Hub editor)
--   chat_memory   — persisted chat history per (agent, user)
--   agents        — live status for the Fleet Map (busy / current_stat)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── agent_config ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_config (
  agent      text PRIMARY KEY,
  name       text NOT NULL,
  role       text,
  emoji      text,
  intro      text,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.agent_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated read agent_config" ON public.agent_config';
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated write agent_config" ON public.agent_config';
  EXECUTE 'DROP POLICY IF EXISTS "Service role agent_config" ON public.agent_config';
END $$;

CREATE POLICY "Authenticated read agent_config"  ON public.agent_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write agent_config" ON public.agent_config FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role agent_config"        ON public.agent_config FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- ─── agent_files ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent      text NOT NULL,
  filename   text NOT NULL,
  content    text NOT NULL DEFAULT '',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(agent, filename)
);
ALTER TABLE public.agent_files ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated manage agent_files" ON public.agent_files';
  EXECUTE 'DROP POLICY IF EXISTS "Service role agent_files" ON public.agent_files';
END $$;

CREATE POLICY "Authenticated manage agent_files" ON public.agent_files FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role agent_files"         ON public.agent_files FOR ALL TO service_role  USING (true) WITH CHECK (true);

-- ─── chat_memory ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_memory (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent      text NOT NULL,
  user_id    uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('user','assistant','system')),
  content    text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_memory_agent_user_idx
  ON public.chat_memory (agent, user_id, created_at);

ALTER TABLE public.chat_memory ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Users manage own chat_memory" ON public.chat_memory';
  EXECUTE 'DROP POLICY IF EXISTS "Service role chat_memory" ON public.chat_memory';
END $$;

CREATE POLICY "Users manage own chat_memory" ON public.chat_memory
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Service role chat_memory"     ON public.chat_memory
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── agents (live status for HQ Fleet Map) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agents (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  room          text,
  role          text,
  busy          boolean NOT NULL DEFAULT false,
  current_stat  text,
  current_task  text,
  updated_at    timestamptz DEFAULT now()
);
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated read agents" ON public.agents';
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated write agents" ON public.agents';
  EXECUTE 'DROP POLICY IF EXISTS "Service role agents" ON public.agents';
END $$;

CREATE POLICY "Authenticated read agents"  ON public.agents FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write agents" ON public.agents FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role agents"        ON public.agents FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Realtime — Fleet Map subscribes to public.agents
DO $$ BEGIN
  EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.agents';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
  WHEN others THEN NULL;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- SEED DATA
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Advisory agents (already used by index.html chat) ──────────────────────
INSERT INTO public.agent_config (agent, name, role, emoji, intro) VALUES
  ('marketing',  'Marketing Agent',  'Campaigns & CPL Optimisation', 'MKT', 'Marketing Agent ready. What do you need?'),
  ('finance',    'Finance Agent',    'P&L & Revenue',                'FIN', 'Finance Agent ready. What do you need?'),
  ('operations', 'Operations Agent', 'Lead Flow & QA',               'OPS', 'Operations Agent ready. What do you need?'),
  ('strategy',   'Strategy Agent',   'Growth Direction',             'STR', 'Strategy Agent ready. What do you need?'),
  ('sales',      'Sales Agent',      'Pipeline & Lead Priority',     'SLS', 'Sales Agent ready. What do you need?')
ON CONFLICT (agent) DO UPDATE
  SET name = EXCLUDED.name,
      role = EXCLUDED.role,
      emoji = EXCLUDED.emoji,
      intro = COALESCE(public.agent_config.intro, EXCLUDED.intro),
      updated_at = now();

-- ─── 15 operational agents from bake-in.html ────────────────────────────────
INSERT INTO public.agent_config (agent, name, role, emoji, intro) VALUES
  -- SALES room
  ('prospector', 'Prospector Agent', 'Outbound prospecting',  'PRO', 'Prospector ready. Who should I reach out to?'),
  ('qualifier',  'Qualifier Agent',  'Inbound qualification', 'QUA', 'Qualifier ready. Send me a lead to qualify.'),
  ('closer',     'Closer Agent',     'Proposals & closing',   'CLO', 'Closer ready. Which deal needs to be closed?'),

  -- DELIVERY room
  ('builder',    'Builder Agent',    'Client onboarding',     'BLD', 'Builder ready. Who am I onboarding?'),
  ('adbot',      'Adbot',            'Meta & Google Ads',     'AD',  'Adbot ready. Which campaign do you want me to look at?'),
  ('landingpg',  'LandingPg Agent',  'Landing page builds',   'LP',  'LandingPg ready. What page do you need?'),

  -- LEAD ENGINE room
  ('smsagent',   'SMS Agent',        'SMS responses',         'SMS', 'SMS Agent ready. New lead inbound?'),
  ('voicebot',   'VoiceBot',         'AI voice calls',        'VC',  'VoiceBot ready. Who am I calling?'),
  ('quoter',     'Quoter Agent',     'Quote drafting',        'QT',  'Quoter ready. Draft a quote for which lead?'),
  ('chaser',     'Chaser Agent',     'Follow-up cadence',     'CHA', 'Chaser ready. Who needs a follow-up today?'),

  -- RETENTION room
  ('pulsecheck', 'PulseCheck Agent', 'Client health checks',  'PC',  'PulseCheck ready. Which clients should I review?'),
  ('churnbot',   'ChurnBot',         'At-risk client alerts', 'CB',  'ChurnBot ready. Which clients are slipping?'),
  ('reporter',   'Reporter Agent',   'Client reports',        'RPT', 'Reporter ready. Which report do you need?'),

  -- OPS room
  ('inbox',      'Inbox Agent',      'Comms triage',          'IN',  'Inbox ready. What needs sorting?'),
  ('bookkeeper', 'Bookkeeper Agent', 'Finance & invoicing',   'BK',  'Bookkeeper ready. What financials do you need?'),
  ('datasyncer', 'DataSyncer',       'CRM sync & cleanup',    'DS',  'DataSyncer ready. What needs syncing?')
ON CONFLICT (agent) DO UPDATE
  SET name = EXCLUDED.name,
      role = EXCLUDED.role,
      emoji = EXCLUDED.emoji,
      intro = COALESCE(public.agent_config.intro, EXCLUDED.intro),
      updated_at = now();

-- ─── agents (Fleet Map live-status rows) ───────────────────────────────────
INSERT INTO public.agents (id, name, room, role, busy, current_stat) VALUES
  ('prospector', 'Prospector', 'SALES',       'Outbound',    false, 'Idle — waiting for queue'),
  ('qualifier',  'Qualifier',  'SALES',       'Inbound',     false, 'Idle — waiting for queue'),
  ('closer',     'Closer',     'SALES',       'Proposals',   false, 'Idle — waiting for queue'),
  ('builder',    'Builder',    'DELIVERY',    'Onboarding',  false, 'Idle — waiting for queue'),
  ('adbot',      'Adbot',      'DELIVERY',    'Meta/Google', false, 'Idle — waiting for queue'),
  ('landingpg',  'LandingPg',  'DELIVERY',    'Pages',       false, 'Idle — waiting for queue'),
  ('smsagent',   'SMSAgent',   'LEAD_ENGINE', 'Respond',     false, 'Idle — waiting for queue'),
  ('voicebot',   'VoiceBot',   'LEAD_ENGINE', 'Calls',       false, 'Idle — waiting for queue'),
  ('quoter',     'Quoter',     'LEAD_ENGINE', 'Quotes',      false, 'Idle — waiting for queue'),
  ('chaser',     'Chaser',     'LEAD_ENGINE', 'Follow-up',   false, 'Idle — waiting for queue'),
  ('pulsecheck', 'PulseCheck', 'RETENTION',   'Health',      false, 'Idle — waiting for queue'),
  ('churnbot',   'ChurnBot',   'RETENTION',   'At-risk',     false, 'Idle — waiting for queue'),
  ('reporter',   'Reporter',   'RETENTION',   'Reports',     false, 'Idle — waiting for queue'),
  ('inbox',      'Inbox',      'OPS',         'Comms',       false, 'Idle — waiting for queue'),
  ('bookkeeper', 'Bookkeeper', 'OPS',         'Finance',     false, 'Idle — waiting for queue'),
  ('datasyncer', 'DataSyncer', 'OPS',         'CRM',         false, 'Idle — waiting for queue')
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      room = EXCLUDED.room,
      role = EXCLUDED.role,
      updated_at = now();

-- ─── Default markdown files for new agents (only if missing) ───────────────
-- A minimal stub so opening any new agent in Agents Hub doesn't show "Loading…".
INSERT INTO public.agent_files (agent, filename, content)
SELECT a.agent, f.filename,
       '# ' || a.name || E'\n\n' ||
       'Role: ' || COALESCE(a.role, '') || E'\n\n' ||
       'Edit this file to define ' || f.filename || ' for ' || a.name || '.'
FROM public.agent_config a
CROSS JOIN (VALUES
  ('agents.md'),
  ('soul.md'),
  ('user.md'),
  ('tools.md'),
  ('__identity__.md')
) AS f(filename)
WHERE a.agent IN (
  'prospector','qualifier','closer',
  'builder','adbot','landingpg',
  'smsagent','voicebot','quoter','chaser',
  'pulsecheck','churnbot','reporter',
  'inbox','bookkeeper','datasyncer'
)
ON CONFLICT (agent, filename) DO NOTHING;
