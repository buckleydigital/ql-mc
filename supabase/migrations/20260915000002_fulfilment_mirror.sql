-- ════════════════════════════════════════════════════════════════════════════
-- Fulfilment: the read side
--
-- WHO OWNS WHAT
--   ql-hq owns fulfilment. The Internal Team - CSMs, ops managers, media
--   buyers - work in its Team Panel, so the step state and the actor-attributed
--   audit trail live there, next to the click that produced them
--   (ql-hq 20260915000001_fulfilment_tracking.sql).
--
--   ql-mc is admin plus sales reps, reps gated exactly as they are now. Its job
--   here is management reporting: which clients are stuck, for how long, and on
--   what. So it holds the DERIVED SUMMARY and nothing else. It is never written
--   by hand and never by a person in this app - only by ql-hq pushing through
--   sync-from-hq, the same bridge stripe-webhook and dispute-lead already use.
--
--   The audit trail is deliberately NOT copied here. One log, in one place,
--   written by the service that performs the actions. A second copy would be a
--   second thing to keep honest, and the moment it disagreed nobody would know
--   which was right.
--
-- WHY NOT JUST KEEP USING onboarding_sub_stage
--   We do keep using it. `clients.onboarding_sub_stage` is what the kanban
--   already renders, so ql-hq maps a completed step onto the exact same strings
--   (fulfilment_step_defs.mc_sub_stage) and the mirror writes that column as
--   well as the new ones. The kanban keeps working untouched and gains history
--   it never had; the new columns are what it could not previously answer -
--   when the stage changed, how much is left, what we are waiting on, and
--   whether that is late.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. The mirror ──────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS fulfilment_steps_done    int,
  ADD COLUMN IF NOT EXISTS fulfilment_steps_settled int,
  ADD COLUMN IF NOT EXISTS fulfilment_steps_total   int,
  ADD COLUMN IF NOT EXISTS fulfilment_blocked_count int,
  ADD COLUMN IF NOT EXISTS fulfilment_stage_at      timestamptz,
  ADD COLUMN IF NOT EXISTS fulfilment_next_step     text,
  ADD COLUMN IF NOT EXISTS fulfilment_next_due      timestamptz,
  ADD COLUMN IF NOT EXISTS fulfilment_synced_at     timestamptz;

COMMENT ON COLUMN public.clients.fulfilment_steps_settled IS
  'Required steps done or deliberately skipped, out of fulfilment_steps_total. The progress numerator: skipping a step is still progress past it.';
COMMENT ON COLUMN public.clients.fulfilment_steps_done IS
  'Required steps actually ticked. Lower than settled where steps were skipped - e.g. a client who pre-dates step tracking.';
COMMENT ON COLUMN public.clients.fulfilment_next_step IS
  'The step this client is actually waiting on, as a ql-hq step_key. NULL once onboarding is complete.';
COMMENT ON COLUMN public.clients.fulfilment_next_due IS
  'When fulfilment_next_step falls due, from its SLA in ql-hq. Past = stuck. Set by the mirror, never by hand.';
COMMENT ON COLUMN public.clients.fulfilment_synced_at IS
  'Last time ql-hq pushed this client''s summary. Stale or NULL on an active onboarding client means the mirror is not arriving.';

-- Ordered so the stuck list is an index scan rather than a sort of every client.
CREATE INDEX IF NOT EXISTS clients_fulfilment_next_due_idx
  ON public.clients (fulfilment_next_due)
  WHERE fulfilment_next_due IS NOT NULL;

-- ─── 2. A view for the stuck list ───────────────────────────────────────────
-- The definition of "stuck" belongs in one place. Putting it here rather than in
-- the dashboard's JavaScript means the panel, any report and anything added
-- later all mean the same thing by it.
--
-- GATING: the view guards itself, and does not rely on the policies on `clients`.
--
-- It would be neater to let RLS do this, but as of this migration `clients`
-- carries a PERMISSIVE policy `auth_all_clients` with USING (true) alongside
-- `clients_full_users_read` (USING NOT is_sales_rep()). Permissive policies are
-- OR-ed, so the permissive true wins and the one intended to restrict reps has
-- no effect - a sales rep can already read every client row. That predates this
-- migration and is reported separately; it is not this migration's to silently
-- change, because rewriting access on `clients` could break the rep dashboard.
--
-- So the rep check is an explicit predicate in the view instead. security_invoker
-- is kept as well, so if and when the policies on `clients` are tightened this
-- view inherits that too rather than bypassing it. Belt and braces, and the
-- gating is true today either way.
CREATE OR REPLACE VIEW public.fulfilment_stuck
WITH (security_invoker = true) AS
SELECT
  c.id                       AS client_id,
  c.company_name,
  c.stage,
  c.onboarding_sub_stage,
  c.ql_hq_company_id,
  c.fulfilment_next_step,
  c.fulfilment_next_due,
  c.fulfilment_blocked_count,
  c.fulfilment_steps_settled,
  c.fulfilment_steps_total,
  c.fulfilment_stage_at,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - c.fulfilment_next_due)) / 3600)::int AS hours_overdue
FROM public.clients c
WHERE NOT public.is_sales_rep()
  AND c.fulfilment_next_step IS NOT NULL
  AND (
    (c.fulfilment_next_due IS NOT NULL AND c.fulfilment_next_due < now())
    OR coalesce(c.fulfilment_blocked_count, 0) > 0
  );

COMMENT ON VIEW public.fulfilment_stuck IS
  'Clients past an SLA or with a blocked step. One definition of stuck, shared by every reader. Returns nothing to a sales rep via its own predicate, not via the policies on clients.';

-- Granted explicitly rather than left to the schema's default privileges: a view
-- nobody may select from is not a feature. The gating is the is_sales_rep()
-- predicate above, not the absence of a grant - a rep may select from this view
-- and simply gets no rows.
GRANT SELECT ON public.fulfilment_stuck TO authenticated, service_role;

-- ─── 3. Who logged that action ──────────────────────────────────────────────
-- client_action_log has recorded calls, emails and meetings since May with no
-- idea who made them - the same gap fulfilment had. Cheap to close and
-- pointless to leave open now that the other side is attributed.
--
-- Nullable and backfill-free on purpose: pretending we know who made a call
-- logged six months ago would be worse than an honest blank.
ALTER TABLE public.client_action_log
  ADD COLUMN IF NOT EXISTS actor_id   uuid,
  ADD COLUMN IF NOT EXISTS actor_name text;

COMMENT ON COLUMN public.client_action_log.actor_name IS
  'Who logged it, denormalised so the row stays readable after the account goes. NULL on rows that pre-date this column.';

-- ─── 4. Note on rep gating for `clients` itself ─────────────────────────────
-- The view above gates itself, so the stuck list is safe. The mirrored COLUMNS,
-- though, live on `clients`, and `clients` does not currently restrict reps: a
-- PERMISSIVE `auth_all_clients` policy with USING (true) OR-s away the
-- `clients_full_users_read` policy that checks is_sales_rep(). 20260618000001
-- only added its restrictive no_sales_rep policy to tables that already had a
-- permissive policy, and whatever created auth_all_clients afterwards reopened
-- this one.
--
-- Deliberately NOT fixed here. Dropping or rewriting a policy on `clients`
-- changes what the rep dashboard can load, which is a decision to make
-- knowingly rather than as a side effect of adding columns. This raises a notice
-- so it is on the record, and the fix is proposed separately.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'clients'
       AND permissive = 'PERMISSIVE' AND coalesce(qual, '') = 'true'
  ) THEN
    RAISE WARNING 'clients has a PERMISSIVE policy with USING (true), so sales reps can read every client row including the fulfilment columns added here. The fulfilment_stuck view is gated independently. Fix the clients policies separately.';
  END IF;
END $$;
