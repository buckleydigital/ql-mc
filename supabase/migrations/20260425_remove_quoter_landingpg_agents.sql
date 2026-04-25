-- ════════════════════════════════════════════════════════════════════════════
-- Remove the `quoter` and `landingpg` agents from the dashboard + database.
--
-- These two bots were retired from the HQ Agent Fleet. The seed entries in
-- 20260425_hq_agents_fleet.sql and 20260425_hq_rooms.sql have been removed
-- (so a fresh DB never gets them) and this migration cleans them up from any
-- existing deployment by:
--   • deleting their rows from agent_runs, chat_memory, agent_files,
--     agent_config, and agents
--   • stripping them out of the `agents` jsonb array on hq_rooms
-- ════════════════════════════════════════════════════════════════════════════

-- Per-agent data
DELETE FROM public.agent_runs   WHERE agent IN ('quoter', 'landingpg');
DELETE FROM public.chat_memory  WHERE agent IN ('quoter', 'landingpg');
DELETE FROM public.agent_files  WHERE agent IN ('quoter', 'landingpg');

-- Catalogue / live status
DELETE FROM public.agent_config WHERE agent IN ('quoter', 'landingpg');
DELETE FROM public.agents       WHERE id    IN ('quoter', 'landingpg');

-- HQ Fleet rooms — drop the two sprites from the jsonb agents array
UPDATE public.hq_rooms
   SET agents = COALESCE(
         (SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(agents) AS elem
           WHERE elem->>'id' NOT IN ('quoter', 'landingpg')),
         '[]'::jsonb
       ),
       updated_at = now()
 WHERE agents @> '[{"id":"quoter"}]'::jsonb
    OR agents @> '[{"id":"landingpg"}]'::jsonb;
