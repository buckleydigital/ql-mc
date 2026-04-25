-- ════════════════════════════════════════════════════════════════════════════
-- Agent Runs — append-only log of scenario start/finish pings from Make.com
--
-- Each Make scenario has two HTTP POST modules (one at the top, one at the
-- end) that hit the `agent-status` edge function with a tiny payload:
--   { agent: "smsagent", scenario: "Inbound SMS Reply", status: "started" }
--   { agent: "smsagent", scenario: "Inbound SMS Reply", status: "finished",
--     log:    "Replied to lead 123 — quote sent" }
--
-- The edge function appends one row here per ping and refreshes the live
-- `public.agents.busy / current_stat` fields so the Fleet Map updates in
-- realtime. Clicking an agent in index.html opens this log.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.agent_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent       text NOT NULL,
  scenario    text,
  status      text NOT NULL,         -- 'started' | 'finished' | 'success' | 'failed' | …
  log         text,                  -- one-line summary on the finished ping
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_agent_created_idx
  ON public.agent_runs (agent, created_at DESC);

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "Authenticated read agent_runs"  ON public.agent_runs';
  EXECUTE 'DROP POLICY IF EXISTS "Service role agent_runs"         ON public.agent_runs';
END $$;

-- Read-only for the dashboard. Writes go through the edge function using the
-- service role key, so authenticated users do not need INSERT.
CREATE POLICY "Authenticated read agent_runs" ON public.agent_runs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role agent_runs"        ON public.agent_runs
  FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Realtime — the agent log modal subscribes to inserts for the open agent.
DO $$ BEGIN
  EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_runs';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
  WHEN others THEN NULL;
END $$;
