-- cron.job_run_details was never cleared (12,000 rows, 15 MB - more than half
-- the database). Keep three days of history, trimmed nightly at 03:17 UTC.

delete from cron.job_run_details where end_time < now() - interval '3 days';

select cron.unschedule('cron-history-trim') where exists (select 1 from cron.job where jobname = 'cron-history-trim');
select cron.schedule('cron-history-trim', '17 3 * * *', $cron$
  delete from cron.job_run_details where end_time < now() - interval '3 days'
$cron$);
