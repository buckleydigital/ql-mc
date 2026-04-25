-- ════════════════════════════════════════════════════════════════════════════
-- HQ Workflows: rename `tool` → `tech_stack`
--
-- The "Make Workflows" tab is now "Tech Stack". Each entry represents the
-- tool/platform that powers that automation — entered manually by the team.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.hq_workflows
  ADD COLUMN IF NOT EXISTS tech_stack text NOT NULL DEFAULT '';

-- Migrate existing data (COALESCE guards against any NULL tool values)
UPDATE public.hq_workflows SET tech_stack = COALESCE(tool, '') WHERE tech_stack = '';

-- Re-seed with Make.com stripped out so only the underlying tools remain.
-- "Make + X" → just "X". Upserts so this is idempotent.
UPDATE public.hq_workflows SET
  tech_stack = REGEXP_REPLACE(COALESCE(tool, ''), '^Make \+ ', '')
WHERE tool LIKE 'Make + %';

-- Drop the old column (renamed above).  Wrapped in DO so re-running is safe.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='hq_workflows' AND column_name='tool'
  ) THEN
    ALTER TABLE public.hq_workflows DROP COLUMN tool;
  END IF;
END $$;
