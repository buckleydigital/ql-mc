-- Less background disk work (Supabase flagged the Disk IO budget).
--
-- jarvis-outbox runs every 5 minutes instead of every minute. It is only the
-- safety net: a bulk send starts straight away when Jarvis queues it and keeps
-- itself going, and this job only calls out when a row is queued or stuck.
-- Its cost was its own bookkeeping - each run writes a row and four updates
-- to cron.job_run_details - 1,440 times a day. A stalled send is now picked up
-- within 5 minutes rather than 1.

select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'jarvis-outbox'),
  schedule := '*/5 * * * *');
