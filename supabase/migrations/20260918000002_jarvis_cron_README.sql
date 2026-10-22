-- Jarvis heartbeat - the one step that cannot be automated from here.
--
-- pg_cron and pg_net are enabled, jarvis-notify is deployed, and the watchers
-- are live. All that is missing is the credential the scheduler calls with, and
-- that is deliberately not in this repo or in any migration: a service role key
-- committed to git is a key you have to rotate.
--
-- Run this ONCE in the Supabase SQL editor, replacing the placeholder with the
-- project's service_role key (Settings -> API -> service_role). It goes into
-- Vault, encrypted, so the cron entry itself never contains it.

-- 1. Store the key.
select vault.create_secret(
  'PASTE_SERVICE_ROLE_KEY_HERE',
  'jarvis_service_key',
  'Service role key used by the Jarvis heartbeat cron to call jarvis-notify'
);

-- 2. Schedule the heartbeat. Every 15 minutes: often enough that a blocked
--    client is noticed the same morning, rare enough that it is ~96 cheap SQL
--    scans a day rather than a cost centre. Quiet hours and the daily cap are
--    enforced inside the function, not here, so the schedule stays dumb.
select cron.schedule(
  'jarvis-heartbeat',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/jarvis-notify',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (
                   select decrypted_secret from vault.decrypted_secrets
                    where name = 'jarvis_service_key'
                 )
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- Useful afterwards:
--   select * from cron.job;                                  -- is it scheduled
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select * from public.jarvis_notifications order by created_at desc limit 5;
--   select kind, count(*) from public.jarvis_events
--     where resolved_at is null group by kind;                -- what is open
--
-- To stop him: select cron.unschedule('jarvis-heartbeat');
-- Or just untick "Alerts on" in Twilio / SMS Settings, which is reversible and
-- leaves the watchers running so the event history stays current.
