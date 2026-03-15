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
  ADD COLUMN IF NOT EXISTS postcodes             text[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS delivery_method       text        DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS delivery_email        text,
  ADD COLUMN IF NOT EXISTS delivery_phone        text,
  ADD COLUMN IF NOT EXISTS custom_fields         jsonb       DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_lead_delivered_at timestamptz,
  -- Ordered list of {key, label} pairs that define which lead fields
  -- appear in the email/SMS notification for this client.
  -- Keys can be any solar_leads column OR a key inside custom_data.
  -- Example: [{"key":"name","label":"Name"},{"key":"monthly_bill","label":"Bill"}]
  ADD COLUMN IF NOT EXISTS lead_template         jsonb;

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

-- ── 11. SOLAR LEADS: Atomic assignment + payload builder for Make.com ──
-- Called by Make immediately after inserting the lead row.
-- 1. Atomically finds the right client (active, covers postcode, longest
--    since last delivery) using FOR UPDATE SKIP LOCKED so two simultaneous
--    Make executions can never double-assign.
-- 2. Increments leads_delivered on the client.
-- 3. Reads the client's lead_template to build a pre-formatted email_html
--    and sms_body — only fields with non-null values are included, and
--    labels come from the template so each client can have custom field names.
--    Any key from solar_leads columns OR from custom_data is supported.
-- 4. Returns everything Make needs: delivery details + pre-built payload.
--    Make just routes and sends — no reformatting required.
CREATE OR REPLACE FUNCTION public.assign_solar_lead(
  p_lead_id  uuid,
  p_postcode text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client      record;
  v_lead        record;
  v_all_fields  jsonb;
  v_template    jsonb;
  v_field       jsonb;
  v_key         text;
  v_label       text;
  v_val         text;
  v_email_rows  text := '';
  v_sms_parts   text[] := ARRAY[]::text[];
  v_email_html  text;
  v_sms_body    text;
BEGIN
  -- ── Step 1: fetch the lead row ──────────────────────────────────────
  SELECT * INTO v_lead FROM public.solar_leads WHERE id = p_lead_id;

  -- ── Step 2: atomically find + lock the right client ─────────────────
  SELECT
    c.id, c.company_name, c.delivery_method,
    c.delivery_email, c.delivery_phone,
    c.custom_fields, c.lead_template
  INTO v_client
  FROM public.clients c
  WHERE c.type  = 'ppl'
    AND c.stage = 'active_client'
    AND c.leads_delivered < (c.total_leads_purchased + COALESCE(c.leads_scrubbed, 0))
    AND p_postcode = ANY(c.postcodes)
  ORDER BY c.last_lead_delivered_at ASC NULLS FIRST
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_client.id IS NULL THEN
    RETURN jsonb_build_object('assigned', false, 'reason', 'no_matching_client');
  END IF;

  -- ── Step 3: merge all lead fields into one flat JSONB map ────────────
  -- Fixed columns first, then custom_data on top so funnels can override
  -- labels or add entirely new fields without a schema change.
  v_all_fields :=
    jsonb_build_object(
      'name',          v_lead.name,
      'email',         v_lead.email,
      'phone',         v_lead.phone,
      'postcode',      v_lead.postcode,
      'address',       v_lead.address,
      'suburb',        v_lead.suburb,
      'state',         v_lead.state,
      'property_type', v_lead.property_type,
      'roof_type',     v_lead.roof_type,
      'monthly_bill',  v_lead.monthly_bill::text,
      'system_size',   v_lead.system_size,
      'interested_in', v_lead.interested_in
    ) || COALESCE(v_lead.custom_data, '{}');

  -- ── Step 4: resolve template ─────────────────────────────────────────
  -- Fall back to showing the four crucial fields if no template is set.
  v_template := COALESCE(
    v_client.lead_template,
    '[
      {"key":"name",     "label":"Name"},
      {"key":"email",    "label":"Email"},
      {"key":"phone",    "label":"Phone"},
      {"key":"postcode", "label":"Postcode"}
    ]'::jsonb
  );

  -- ── Step 5: build email HTML + SMS text (skip blank fields) ──────────
  FOR v_field IN SELECT value FROM jsonb_array_elements(v_template) LOOP
    v_key   := v_field->>'key';
    v_label := COALESCE(v_field->>'label', v_key);
    v_val   := v_all_fields->>v_key;

    IF v_val IS NOT NULL AND trim(v_val) != '' THEN
      v_email_rows := v_email_rows
        || '<tr>'
        || '<td style="padding:6px 12px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">' || v_label || '</td>'
        || '<td style="padding:6px 0;font-size:13px;color:#111">' || v_val || '</td>'
        || '</tr>';
      v_sms_parts := v_sms_parts || (v_label || ': ' || v_val);
    END IF;
  END LOOP;

  v_email_html :=
    '<div style="font-family:sans-serif;max-width:480px">'
    || '<p style="font-size:15px;font-weight:600;margin:0 0 12px">New Solar Lead — ' || v_lead.name || '</p>'
    || '<table style="border-collapse:collapse;width:100%">' || v_email_rows || '</table>'
    || '<p style="font-size:11px;color:#aaa;margin:16px 0 0">Exclusive lead distributed to ' || v_client.company_name || ' · QL Mission Control</p>'
    || '</div>';

  v_sms_body := array_to_string(v_sms_parts, ' | ');

  -- ── Step 6: increment counter + stamp the client ─────────────────────
  UPDATE public.clients
  SET leads_delivered        = leads_delivered + 1,
      last_lead_delivered_at = now(),
      updated_at             = now()
  WHERE id = v_client.id;

  -- ── Step 7: update the lead row ──────────────────────────────────────
  UPDATE public.solar_leads
  SET assigned_client_id = v_client.id,
      assigned_at        = now(),
      status             = 'assigned',
      delivery_method    = v_client.delivery_method,
      updated_at         = now()
  WHERE id = p_lead_id;

  -- ── Step 8: return everything Make needs ─────────────────────────────
  RETURN jsonb_build_object(
    'assigned',        true,
    'client_id',       v_client.id,
    'company_name',    v_client.company_name,
    'delivery_method', v_client.delivery_method,
    'delivery_email',  v_client.delivery_email,
    'delivery_phone',  v_client.delivery_phone,
    'custom_fields',   COALESCE(v_client.custom_fields, '{}'),
    -- Pre-built payload — Make just sends these directly, no reformatting
    'email_subject',   'New Lead — ' || v_lead.name || ' (' || v_lead.postcode || ')',
    'email_html',      v_email_html,
    'sms_body',        v_sms_body
  );
END;
$$;

-- ── 13. SOLAR LEADS: Add new standard lead fields ──
ALTER TABLE public.solar_leads
  ADD COLUMN IF NOT EXISTS is_homeowner       text,    -- 'Yes' / 'No'
  ADD COLUMN IF NOT EXISTS avg_quarterly_bill numeric, -- average quarterly electricity bill
  ADD COLUMN IF NOT EXISTS purchase_timeline  text;    -- e.g. 'ASAP', '1-3 months', '6-12 months'

-- ── 14. CLIENTS: Add weekly and monthly lead caps ──
-- NULL = no cap (unlimited). Caps are checked live against solar_leads.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS weekly_cap  integer,
  ADD COLUMN IF NOT EXISTS monthly_cap integer;

-- ── 15. SOLAR LEADS: Update assignment function with new fields + cap enforcement ──
CREATE OR REPLACE FUNCTION public.assign_solar_lead(
  p_lead_id  uuid,
  p_postcode text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client      record;
  v_lead        record;
  v_all_fields  jsonb;
  v_template    jsonb;
  v_field       jsonb;
  v_key         text;
  v_label       text;
  v_val         text;
  v_email_rows  text := '';
  v_sms_parts   text[] := ARRAY[]::text[];
  v_email_html  text;
  v_sms_body    text;
BEGIN
  -- ── Step 1: fetch the lead row ──────────────────────────────────────
  SELECT * INTO v_lead FROM public.solar_leads WHERE id = p_lead_id;

  -- ── Step 2: atomically find + lock the right client ─────────────────
  -- Eligibility: active PPL, leads remaining, covers postcode, under caps.
  -- Priority: whoever has gone the longest since their last lead (round-robin).
  SELECT
    c.id, c.company_name, c.delivery_method,
    c.delivery_email, c.delivery_phone,
    c.custom_fields, c.lead_template
  INTO v_client
  FROM public.clients c
  WHERE c.type  = 'ppl'
    AND c.stage = 'active_client'
    AND c.leads_delivered < (c.total_leads_purchased + COALESCE(c.leads_scrubbed, 0))
    AND p_postcode = ANY(c.postcodes)
    -- Weekly cap: null = no limit
    AND (
      c.weekly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('week', now())
      ) < c.weekly_cap
    )
    -- Monthly cap: null = no limit
    AND (
      c.monthly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('month', now())
      ) < c.monthly_cap
    )
  ORDER BY c.last_lead_delivered_at ASC NULLS FIRST
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_client.id IS NULL THEN
    RETURN jsonb_build_object('assigned', false, 'reason', 'no_matching_client');
  END IF;

  -- ── Step 3: merge all lead fields into one flat JSONB map ────────────
  v_all_fields :=
    jsonb_build_object(
      'name',              v_lead.name,
      'email',             v_lead.email,
      'phone',             v_lead.phone,
      'postcode',          v_lead.postcode,
      'address',           v_lead.address,
      'suburb',            v_lead.suburb,
      'state',             v_lead.state,
      'is_homeowner',      v_lead.is_homeowner,
      'avg_quarterly_bill',v_lead.avg_quarterly_bill::text,
      'purchase_timeline', v_lead.purchase_timeline,
      'property_type',     v_lead.property_type,
      'roof_type',         v_lead.roof_type,
      'monthly_bill',      v_lead.monthly_bill::text,
      'system_size',       v_lead.system_size,
      'interested_in',     v_lead.interested_in,
      'phone_verified',    v_lead.phone_verified::text,
      'email_verified',    v_lead.email_verified::text
    ) || COALESCE(v_lead.custom_data, '{}');

  -- ── Step 4: resolve template (default = 7 standard fields) ──────────
  v_template := COALESCE(
    v_client.lead_template,
    '[
      {"key":"name",               "label":"Name"},
      {"key":"email",              "label":"Email"},
      {"key":"phone",              "label":"Phone"},
      {"key":"postcode",           "label":"Postcode"},
      {"key":"is_homeowner",       "label":"Home Owner"},
      {"key":"avg_quarterly_bill", "label":"Avg Quarterly Bill"},
      {"key":"purchase_timeline",  "label":"Purchase Timeline"}
    ]'::jsonb
  );

  -- ── Step 5: build email HTML + SMS text (skip blank fields) ──────────
  FOR v_field IN SELECT value FROM jsonb_array_elements(v_template) LOOP
    v_key   := v_field->>'key';
    v_label := COALESCE(v_field->>'label', v_key);
    v_val   := v_all_fields->>v_key;

    IF v_val IS NOT NULL AND trim(v_val) != '' THEN
      v_email_rows := v_email_rows
        || '<tr>'
        || '<td style="padding:6px 12px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">' || v_label || '</td>'
        || '<td style="padding:6px 0;font-size:13px;color:#111">' || v_val || '</td>'
        || '</tr>';
      v_sms_parts := v_sms_parts || (v_label || ': ' || v_val);
    END IF;
  END LOOP;

  v_email_html :=
    '<div style="font-family:sans-serif;max-width:480px">'
    || '<p style="font-size:15px;font-weight:600;margin:0 0 12px">New Solar Lead — ' || v_lead.name || '</p>'
    || '<table style="border-collapse:collapse;width:100%">' || v_email_rows || '</table>'
    || '<p style="font-size:11px;color:#aaa;margin:16px 0 0">Exclusive lead distributed to ' || v_client.company_name || ' · QL Mission Control</p>'
    || '</div>';

  v_sms_body := array_to_string(v_sms_parts, ' | ');

  -- ── Step 6: increment counter + stamp the client ─────────────────────
  UPDATE public.clients
  SET leads_delivered        = leads_delivered + 1,
      last_lead_delivered_at = now(),
      updated_at             = now()
  WHERE id = v_client.id;

  -- ── Step 7: update the lead row ──────────────────────────────────────
  UPDATE public.solar_leads
  SET assigned_client_id = v_client.id,
      assigned_at        = now(),
      status             = 'assigned',
      delivery_method    = v_client.delivery_method,
      updated_at         = now()
  WHERE id = p_lead_id;

  -- ── Step 8: return everything Make needs ─────────────────────────────
  RETURN jsonb_build_object(
    'assigned',        true,
    'client_id',       v_client.id,
    'company_name',    v_client.company_name,
    'delivery_method', v_client.delivery_method,
    'delivery_email',  v_client.delivery_email,
    'delivery_phone',  v_client.delivery_phone,
    'custom_fields',   COALESCE(v_client.custom_fields, '{}'),
    'email_subject',   'New Lead — ' || v_lead.name || ' (' || v_lead.postcode || ')',
    'email_html',      v_email_html,
    'sms_body',        v_sms_body
  );
END;
$$;

-- ── 16. SOLAR LEADS: Add verification flags ──
ALTER TABLE public.solar_leads
  ADD COLUMN IF NOT EXISTS phone_verified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false;

-- ── 17. SOLAR LEADS: Auto-append custom_data fields below template fields ──
-- Any key in custom_data that isn't already listed in the client's lead_template
-- is automatically appended at the bottom of the email and SMS output.
CREATE OR REPLACE FUNCTION public.assign_solar_lead(
  p_lead_id  uuid,
  p_postcode text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client        record;
  v_lead          record;
  v_all_fields    jsonb;
  v_template      jsonb;
  v_field         jsonb;
  v_key           text;
  v_label         text;
  v_val           text;
  v_email_rows    text := '';
  v_sms_parts     text[] := ARRAY[]::text[];
  v_email_html    text;
  v_sms_body      text;
  v_rendered_keys text[] := ARRAY[]::text[];  -- tracks keys already rendered
  v_cd_key        text;
  v_cd_val        text;
BEGIN
  -- ── Step 1: fetch the lead row ──────────────────────────────────────
  SELECT * INTO v_lead FROM public.solar_leads WHERE id = p_lead_id;

  -- ── Step 2: atomically find + lock the right client ─────────────────
  SELECT
    c.id, c.company_name, c.delivery_method,
    c.delivery_email, c.delivery_phone,
    c.custom_fields, c.lead_template
  INTO v_client
  FROM public.clients c
  WHERE c.type  = 'ppl'
    AND c.stage = 'active_client'
    AND c.leads_delivered < (c.total_leads_purchased + COALESCE(c.leads_scrubbed, 0))
    AND p_postcode = ANY(c.postcodes)
    AND (
      c.weekly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('week', now())
      ) < c.weekly_cap
    )
    AND (
      c.monthly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('month', now())
      ) < c.monthly_cap
    )
  ORDER BY c.last_lead_delivered_at ASC NULLS FIRST
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_client.id IS NULL THEN
    RETURN jsonb_build_object('assigned', false, 'reason', 'no_matching_client');
  END IF;

  -- ── Step 3: merge all lead fields into one flat JSONB map ────────────
  v_all_fields :=
    jsonb_build_object(
      'name',              v_lead.name,
      'email',             v_lead.email,
      'phone',             v_lead.phone,
      'postcode',          v_lead.postcode,
      'address',           v_lead.address,
      'suburb',            v_lead.suburb,
      'state',             v_lead.state,
      'is_homeowner',      v_lead.is_homeowner,
      'avg_quarterly_bill',v_lead.avg_quarterly_bill::text,
      'purchase_timeline', v_lead.purchase_timeline,
      'property_type',     v_lead.property_type,
      'roof_type',         v_lead.roof_type,
      'monthly_bill',      v_lead.monthly_bill::text,
      'system_size',       v_lead.system_size,
      'interested_in',     v_lead.interested_in,
      'phone_verified',    v_lead.phone_verified::text,
      'email_verified',    v_lead.email_verified::text
    ) || COALESCE(v_lead.custom_data, '{}');

  -- ── Step 4: resolve template ─────────────────────────────────────────
  v_template := COALESCE(
    v_client.lead_template,
    '[
      {"key":"name",               "label":"Name"},
      {"key":"email",              "label":"Email"},
      {"key":"phone",              "label":"Phone"},
      {"key":"postcode",           "label":"Postcode"},
      {"key":"is_homeowner",       "label":"Home Owner"},
      {"key":"avg_quarterly_bill", "label":"Avg Quarterly Bill"},
      {"key":"purchase_timeline",  "label":"Purchase Timeline"}
    ]'::jsonb
  );

  -- ── Step 5: render template fields ───────────────────────────────────
  FOR v_field IN SELECT value FROM jsonb_array_elements(v_template) LOOP
    v_key   := v_field->>'key';
    v_label := COALESCE(v_field->>'label', v_key);
    v_val   := v_all_fields->>v_key;

    -- Track which keys we've already rendered so custom_data doesn't repeat them
    v_rendered_keys := v_rendered_keys || v_key;

    IF v_val IS NOT NULL AND trim(v_val) != '' THEN
      v_email_rows := v_email_rows
        || '<tr>'
        || '<td style="padding:6px 12px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">' || v_label || '</td>'
        || '<td style="padding:6px 0;font-size:13px;color:#111">' || v_val || '</td>'
        || '</tr>';
      v_sms_parts := v_sms_parts || (v_label || ': ' || v_val);
    END IF;
  END LOOP;

  -- ── Step 5b: append any custom_data keys not already in the template ─
  -- Labels are title-cased from the key (underscores → spaces).
  FOR v_cd_key, v_cd_val IN
    SELECT key, value FROM jsonb_each_text(COALESCE(v_lead.custom_data, '{}'))
    ORDER BY key
  LOOP
    CONTINUE WHEN v_cd_key = ANY(v_rendered_keys);
    CONTINUE WHEN v_cd_val IS NULL OR trim(v_cd_val) = '';

    v_label := initcap(replace(v_cd_key, '_', ' '));

    v_email_rows := v_email_rows
      || '<tr>'
      || '<td style="padding:6px 12px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">' || v_label || '</td>'
      || '<td style="padding:6px 0;font-size:13px;color:#111">' || v_cd_val || '</td>'
      || '</tr>';
    v_sms_parts := v_sms_parts || (v_label || ': ' || v_cd_val);
  END LOOP;

  v_email_html :=
    '<div style="font-family:sans-serif;max-width:480px">'
    || '<p style="font-size:15px;font-weight:600;margin:0 0 12px">New Solar Lead — ' || v_lead.name || '</p>'
    || '<table style="border-collapse:collapse;width:100%">' || v_email_rows || '</table>'
    || '<p style="font-size:11px;color:#aaa;margin:16px 0 0">Exclusive lead distributed to ' || v_client.company_name || ' · QL Mission Control</p>'
    || '</div>';

  v_sms_body := array_to_string(v_sms_parts, ' | ');

  -- ── Step 6: increment counter + stamp the client ─────────────────────
  UPDATE public.clients
  SET leads_delivered        = leads_delivered + 1,
      last_lead_delivered_at = now(),
      updated_at             = now()
  WHERE id = v_client.id;

  -- ── Step 7: update the lead row ──────────────────────────────────────
  UPDATE public.solar_leads
  SET assigned_client_id = v_client.id,
      assigned_at        = now(),
      status             = 'assigned',
      delivery_method    = v_client.delivery_method,
      updated_at         = now()
  WHERE id = p_lead_id;

  -- ── Step 8: return everything Make needs ─────────────────────────────
  RETURN jsonb_build_object(
    'assigned',        true,
    'client_id',       v_client.id,
    'company_name',    v_client.company_name,
    'delivery_method', v_client.delivery_method,
    'delivery_email',  v_client.delivery_email,
    'delivery_phone',  v_client.delivery_phone,
    'custom_fields',   COALESCE(v_client.custom_fields, '{}'),
    'email_subject',   'New Lead — ' || v_lead.name || ' (' || v_lead.postcode || ')',
    'email_html',      v_email_html,
    'sms_body',        v_sms_body
  );
END;
$$;

-- ── 18. VERIFICATION ──
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

-- ── 19. LEADS: Secure insert function with duplicate guard ──
-- Replaces the direct client-side INSERT so server-side validation is enforced.
-- Deduplication: if a lead with the same name + email (or name + phone) already
-- exists the function returns the existing row's id and duplicate=true instead
-- of inserting a second copy.
-- Returns: { id, duplicate }
CREATE OR REPLACE FUNCTION public.add_lead(
  p_name       text,
  p_company    text    DEFAULT NULL,
  p_email      text    DEFAULT NULL,
  p_phone      text    DEFAULT NULL,
  p_stage      text    DEFAULT 'new',
  p_lead_type  text    DEFAULT NULL,
  p_value      numeric DEFAULT NULL,
  p_source     text    DEFAULT NULL,
  p_notes      text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lead record;
  v_id   uuid;
BEGIN
  -- Require a contact name
  IF trim(p_name) = '' OR p_name IS NULL THEN
    RAISE EXCEPTION 'name is required';
  END IF;

  -- Duplicate check: same name + (email match OR phone match)
  SELECT * INTO v_lead
  FROM public.leads
  WHERE name = trim(p_name)
    AND (
      (p_email IS NOT NULL AND email = trim(p_email))
      OR
      (p_phone IS NOT NULL AND phone = trim(p_phone))
    )
  LIMIT 1;

  IF v_lead IS NULL THEN
    INSERT INTO public.leads (name, company, email, phone, stage, lead_type, value, source, notes, created_at, updated_at)
    VALUES (
      trim(p_name),
      NULLIF(trim(COALESCE(p_company, '')), ''),
      NULLIF(trim(COALESCE(p_email,   '')), ''),
      NULLIF(trim(COALESCE(p_phone,   '')), ''),
      COALESCE(p_stage, 'new'),
      p_lead_type,
      p_value,
      p_source,
      NULLIF(trim(COALESCE(p_notes, '')), ''),
      now(),
      now()
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'duplicate', false);
  ELSE
    RETURN jsonb_build_object('id', v_lead.id, 'duplicate', true);
  END IF;
END;
$$;

-- Allow authenticated users to call this function
GRANT EXECUTE ON FUNCTION public.add_lead(text,text,text,text,text,text,numeric,text,text) TO authenticated;

-- ── 20. SOLAR LEADS: Restore 'delivered' status + add delivery audit log ──
-- 'assigned'  = Make has matched a client and will attempt delivery
-- 'delivered' = status set directly via Supabase client once delivery is confirmed

-- Re-add 'delivered' to the CHECK constraint (drop + recreate)
ALTER TABLE public.solar_leads
  DROP CONSTRAINT IF EXISTS solar_leads_status_check;
ALTER TABLE public.solar_leads
  ADD CONSTRAINT solar_leads_status_check
    CHECK (status IN ('pending','assigned','delivered','failed','scrubbed'));

-- Audit log column (plain text, newline-delimited entries)
ALTER TABLE public.solar_leads
  ADD COLUMN IF NOT EXISTS delivery_audit_log text;

-- ── 21. PPL CLIENTS: QuoteLeads platform account fields ──
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS has_quoteleads_platform_account boolean NOT NULL DEFAULT false;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS platform_email text;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS twilio_phone text;

-- ── 22. ASSIGN_SOLAR_LEAD: Return QuoteLeads platform fields ──
-- Adds has_quoteleads_platform_account, platform_email, twilio_phone
-- to the response so Make.com can branch on platform account existence.
CREATE OR REPLACE FUNCTION public.assign_solar_lead(
  p_lead_id  uuid,
  p_postcode text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_client        record;
  v_lead          record;
  v_all_fields    jsonb;
  v_template      jsonb;
  v_field         jsonb;
  v_key           text;
  v_label         text;
  v_val           text;
  v_email_rows    text := '';
  v_sms_parts     text[] := ARRAY[]::text[];
  v_email_html    text;
  v_sms_body      text;
  v_rendered_keys text[] := ARRAY[]::text[];
  v_cd_key        text;
  v_cd_val        text;
BEGIN
  -- ── Step 1: fetch the lead row ──────────────────────────────────────
  SELECT * INTO v_lead FROM public.solar_leads WHERE id = p_lead_id;

  -- ── Step 2: atomically find + lock the right client ─────────────────
  SELECT
    c.id, c.company_name, c.delivery_method,
    c.delivery_email, c.delivery_phone,
    c.custom_fields, c.lead_template,
    c.has_quoteleads_platform_account, c.platform_email, c.twilio_phone
  INTO v_client
  FROM public.clients c
  WHERE c.type  = 'ppl'
    AND c.stage = 'active_client'
    AND c.leads_delivered < (c.total_leads_purchased + COALESCE(c.leads_scrubbed, 0))
    AND p_postcode = ANY(c.postcodes)
    AND (
      c.weekly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('week', now())
      ) < c.weekly_cap
    )
    AND (
      c.monthly_cap IS NULL OR (
        SELECT COUNT(*) FROM public.solar_leads sl
        WHERE sl.assigned_client_id = c.id
          AND sl.assigned_at >= date_trunc('month', now())
      ) < c.monthly_cap
    )
  ORDER BY c.last_lead_delivered_at ASC NULLS FIRST
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_client.id IS NULL THEN
    RETURN jsonb_build_object('assigned', false, 'reason', 'no_matching_client');
  END IF;

  -- ── Step 3: merge all lead fields into one flat JSONB map ────────────
  v_all_fields :=
    jsonb_build_object(
      'name',              v_lead.name,
      'email',             v_lead.email,
      'phone',             v_lead.phone,
      'postcode',          v_lead.postcode,
      'address',           v_lead.address,
      'suburb',            v_lead.suburb,
      'state',             v_lead.state,
      'is_homeowner',      v_lead.is_homeowner,
      'avg_quarterly_bill',v_lead.avg_quarterly_bill::text,
      'purchase_timeline', v_lead.purchase_timeline,
      'property_type',     v_lead.property_type,
      'roof_type',         v_lead.roof_type,
      'monthly_bill',      v_lead.monthly_bill::text,
      'system_size',       v_lead.system_size,
      'interested_in',     v_lead.interested_in,
      'phone_verified',    v_lead.phone_verified::text,
      'email_verified',    v_lead.email_verified::text
    ) || COALESCE(v_lead.custom_data, '{}');

  -- ── Step 4: resolve template ─────────────────────────────────────────
  v_template := COALESCE(
    v_client.lead_template,
    '[
      {"key":"name",               "label":"Name"},
      {"key":"email",              "label":"Email"},
      {"key":"phone",              "label":"Phone"},
      {"key":"postcode",           "label":"Postcode"},
      {"key":"is_homeowner",       "label":"Home Owner"},
      {"key":"avg_quarterly_bill", "label":"Avg Quarterly Bill"},
      {"key":"purchase_timeline",  "label":"Purchase Timeline"}
    ]'::jsonb
  );

  -- ── Step 5: render template fields ───────────────────────────────────
  FOR v_field IN SELECT value FROM jsonb_array_elements(v_template) LOOP
    v_key   := v_field->>'key';
    v_label := COALESCE(v_field->>'label', v_key);
    v_val   := v_all_fields->>v_key;

    v_rendered_keys := v_rendered_keys || v_key;

    IF v_val IS NOT NULL AND trim(v_val) != '' THEN
      v_email_rows := v_email_rows
        || '<tr>'
        || '<td style="padding:6px 12px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">' || v_label || '</td>'
        || '<td style="padding:6px 0;font-size:13px;color:#111">' || v_val || '</td>'
        || '</tr>';
      v_sms_parts := v_sms_parts || (v_label || ': ' || v_val);
    END IF;
  END LOOP;

  -- ── Step 5b: append any custom_data keys not already in the template ─
  FOR v_cd_key, v_cd_val IN
    SELECT key, value FROM jsonb_each_text(COALESCE(v_lead.custom_data, '{}'))
    ORDER BY key
  LOOP
    CONTINUE WHEN v_cd_key = ANY(v_rendered_keys);
    CONTINUE WHEN v_cd_val IS NULL OR trim(v_cd_val) = '';

    v_label := initcap(replace(v_cd_key, '_', ' '));

    v_email_rows := v_email_rows
      || '<tr>'
      || '<td style="padding:6px 12px 6px 0;color:#888;font-size:13px;white-space:nowrap;vertical-align:top">' || v_label || '</td>'
      || '<td style="padding:6px 0;font-size:13px;color:#111">' || v_cd_val || '</td>'
      || '</tr>';
    v_sms_parts := v_sms_parts || (v_label || ': ' || v_cd_val);
  END LOOP;

  v_email_html :=
    '<div style="font-family:sans-serif;max-width:480px">'
    || '<p style="font-size:15px;font-weight:600;margin:0 0 12px">New Solar Lead — ' || v_lead.name || '</p>'
    || '<table style="border-collapse:collapse;width:100%">' || v_email_rows || '</table>'
    || '<p style="font-size:11px;color:#aaa;margin:16px 0 0">Exclusive lead distributed to ' || v_client.company_name || ' · QL Mission Control</p>'
    || '</div>';

  v_sms_body := array_to_string(v_sms_parts, ' | ');

  -- ── Step 6: increment counter + stamp the client ─────────────────────
  UPDATE public.clients
  SET leads_delivered        = leads_delivered + 1,
      last_lead_delivered_at = now(),
      updated_at             = now()
  WHERE id = v_client.id;

  -- ── Step 7: update the lead row ──────────────────────────────────────
  UPDATE public.solar_leads
  SET assigned_client_id = v_client.id,
      assigned_at        = now(),
      status             = 'assigned',
      delivery_method    = v_client.delivery_method,
      updated_at         = now()
  WHERE id = p_lead_id;

  -- ── Step 8: return everything Make needs ─────────────────────────────
  RETURN jsonb_build_object(
    'assigned',                        true,
    'client_id',                       v_client.id,
    'company_name',                    v_client.company_name,
    'delivery_method',                 v_client.delivery_method,
    'delivery_email',                  v_client.delivery_email,
    'delivery_phone',                  v_client.delivery_phone,
    'custom_fields',                   COALESCE(v_client.custom_fields, '{}'),
    'has_quoteleads_platform_account', v_client.has_quoteleads_platform_account,
    'platform_email',                  v_client.platform_email,
    'twilio_phone',                    v_client.twilio_phone,
    'email_subject',                   'New Lead — ' || v_lead.name || ' (' || v_lead.postcode || ')',
    'email_html',                      v_email_html,
    'sms_body',                        v_sms_body
  );
END;
$$;
