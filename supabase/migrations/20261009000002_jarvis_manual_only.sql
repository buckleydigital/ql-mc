-- Jarvis runs only when someone asks him something.
--
-- The heartbeat (jarvis-heartbeat, every 15 minutes) was the one thing that
-- could spend Anthropic credit with nobody asking: it ran his scheduled jobs
-- through jarvis-chat. Jobs are gone from his tools, jarvis-chat refuses
-- via:'job', and jarvis-notify no longer runs them. This takes the cron away
-- too, which also stops the free panel alerts it left.
--
-- Left running, neither of which calls a model:
--   jarvis-outbox      - finishes a bulk send Jarvis was asked to queue;
--   cron-history-trim  - housekeeping.
--
-- To bring the alerts back (still no model calls): re-run the schedule in
-- 20260918000002_jarvis_cron_README.sql.

select cron.unschedule('jarvis-heartbeat') where exists (select 1 from cron.job where jobname = 'jarvis-heartbeat');

update public.jarvis_jobs set active = false where active;
