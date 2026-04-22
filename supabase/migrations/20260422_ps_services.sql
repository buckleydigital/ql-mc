-- PS Services: Appointment Setting pipeline
-- Tables: comm_solar_appointments, ps_clients, ps_call_log, ps_ad_accounts
-- Account type 'ps_services' can ONLY access these tables via RLS.

-- ── comm_solar_appointments ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comm_solar_appointments (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  phone       text        NOT NULL,
  email       text,
  stage       text        NOT NULL DEFAULT 'new_lead'
                            CHECK (stage IN ('new_lead','no_answer','appointment_booked','disputed')),
  notes       text,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE comm_solar_appointments ENABLE ROW LEVEL SECURITY;

-- Authenticated users (admin + ps_services) can read/update
DROP POLICY IF EXISTS "ps_appt_read" ON comm_solar_appointments;
CREATE POLICY "ps_appt_read" ON comm_solar_appointments
  FOR SELECT TO authenticated USING (true);

-- Only non-ps_services (admin) can insert
DROP POLICY IF EXISTS "ps_appt_insert_admin" ON comm_solar_appointments;
CREATE POLICY "ps_appt_insert_admin" ON comm_solar_appointments
  FOR INSERT TO authenticated
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'account_type') IS DISTINCT FROM 'ps_services'
  );

-- Both can update (stage moves)
DROP POLICY IF EXISTS "ps_appt_update" ON comm_solar_appointments;
CREATE POLICY "ps_appt_update" ON comm_solar_appointments
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Only admin can delete
DROP POLICY IF EXISTS "ps_appt_delete_admin" ON comm_solar_appointments;
CREATE POLICY "ps_appt_delete_admin" ON comm_solar_appointments
  FOR DELETE TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'account_type') IS DISTINCT FROM 'ps_services'
  );

-- ── ps_clients ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ps_clients (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  revenue     numeric     NOT NULL DEFAULT 0,
  closed_at   date,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ps_clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ps_clients_all" ON ps_clients;
CREATE POLICY "ps_clients_all" ON ps_clients
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── ps_call_log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ps_call_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid        REFERENCES comm_solar_appointments(id) ON DELETE SET NULL,
  lead_name       text,
  lead_phone      text,
  called_by       text,
  twilio_call_sid text,
  duration_sec    integer,
  status          text        NOT NULL DEFAULT 'initiated',
  error_message   text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

ALTER TABLE ps_call_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ps_call_log_all" ON ps_call_log;
CREATE POLICY "ps_call_log_all" ON ps_call_log
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── ps_ad_accounts ────────────────────────────────────────────────────────────
-- Stores the ad account + campaign IDs to sync for PS dashboard
CREATE TABLE IF NOT EXISTS ps_ad_accounts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label           text        NOT NULL DEFAULT 'PS Ad Account',
  account_id      text        NOT NULL,
  campaign_ids    text[]      NOT NULL DEFAULT '{}',
  lifetime_spend  numeric     DEFAULT 0,
  last_synced_at  timestamptz,
  sync_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ps_ad_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ps_ad_accounts_all" ON ps_ad_accounts;
CREATE POLICY "ps_ad_accounts_all" ON ps_ad_accounts
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
