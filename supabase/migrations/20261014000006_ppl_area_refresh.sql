-- Pay-per-lead area routing.
--
-- ql-hq splits a pay-per-lead order into areas, each its own order with its
-- own postcodes and number of leads. Every five minutes ppl-area-refresh asks
-- ql-hq which postcodes each company still has room in and writes them onto
-- clients.postcodes, which submit-lead routes by, so a full area stops
-- receiving leads. Companies on older, unsplit orders are left as they are.
select cron.schedule('ppl-area-refresh', '*/5 * * * *', $cron$
  select net.http_post(
    url     := 'https://wmegoygrancfwxagqskh.supabase.co/functions/v1/ppl-area-refresh',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_service_key')),
    body    := '{}'::jsonb)
$cron$);
