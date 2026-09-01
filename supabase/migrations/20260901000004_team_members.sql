-- ════════════════════════════════════════════════════════════════════════════
-- Team members (non-rep roles)
--
-- Sales reps are login accounts: they exist in auth.users, carry
-- app_metadata.account_type = 'sales_rep', and `sales_reps` only mirrors them
-- so the admin panel and the auto-assign trigger can read the roster. The
-- roles we track here - CSM, Ops Manager, Tech Lead, Media Buyer - are the
-- opposite: people we need on the books (who they are, what they cost, are
-- they still with us) but who get no dashboard login. So they get a plain
-- roster table rather than an account type, and nothing about rep scoping or
-- lead assignment changes.
--
-- The hiring pipeline feeds this table: a candidate hired for one of these
-- roles becomes a row here. `role` is a closed set so the Team panel can count
-- and group by it; widen the CHECK when a new role appears.
--
-- Visibility: full internal users only, same as the hiring pipeline.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.team_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  role          text NOT NULL
                  CHECK (role IN ('csm','ops_manager','tech_lead','media_buyer')),
  email         text,
  phone         text,
  active        boolean NOT NULL DEFAULT true,
  start_date    date,
  pay_rate_role text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);

COMMENT ON TABLE  public.team_members               IS 'Internal team roster for non-login roles (CSM, Ops Manager, Tech Lead, Media Buyer). Sales reps live in sales_reps because they are auth accounts.';
COMMENT ON COLUMN public.team_members.pay_rate_role IS 'Optional free-text match against pay_rates.role_type, so a member points at the rate that pays them.';

CREATE INDEX IF NOT EXISTS team_members_role_idx   ON public.team_members (role);
CREATE INDEX IF NOT EXISTS team_members_active_idx ON public.team_members (active);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_members_select" ON public.team_members;
DROP POLICY IF EXISTS "team_members_insert" ON public.team_members;
DROP POLICY IF EXISTS "team_members_update" ON public.team_members;
DROP POLICY IF EXISTS "team_members_delete" ON public.team_members;

CREATE POLICY "team_members_select" ON public.team_members
  FOR SELECT TO authenticated USING (NOT public.is_sales_rep());
CREATE POLICY "team_members_insert" ON public.team_members
  FOR INSERT TO authenticated WITH CHECK (NOT public.is_sales_rep());
CREATE POLICY "team_members_update" ON public.team_members
  FOR UPDATE TO authenticated
  USING (NOT public.is_sales_rep()) WITH CHECK (NOT public.is_sales_rep());
CREATE POLICY "team_members_delete" ON public.team_members
  FOR DELETE TO authenticated USING (NOT public.is_sales_rep());
