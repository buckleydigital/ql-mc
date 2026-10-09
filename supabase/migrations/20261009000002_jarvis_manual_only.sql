-- Jarvis spends API credit only when someone asks him something.
--
-- His self-scheduled jobs were the one way he could call Claude with nobody
-- asking: the heartbeat ran each due job through jarvis-chat. The job tools
-- are gone, jarvis-chat refuses via:'job' and jarvis-notify no longer runs
-- jobs. This switches off any left in the table.
--
-- The crons all stay. None of them calls a model:
--   jarvis-heartbeat   - SQL watchers and panel alerts;
--   jarvis-outbox      - finishes a bulk send Jarvis was asked to queue;
--   cron-history-trim  - housekeeping.

update public.jarvis_jobs set active = false where active;
