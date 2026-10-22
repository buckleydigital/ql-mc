-- Cold outreach: finding runs only when started by hand.
--
-- 20261007000002 scheduled outreach-find daily at 6am Brisbane. Each run costs
-- money (Google searches, email verifications), so it is now started only by
-- "Run today's search" in the dashboard (outreach_run_now), once per day it is
-- wanted. No schedule means no spend on a day nobody presses it.
select cron.unschedule('outreach-find') where exists (select 1 from cron.job where jobname = 'outreach-find');
