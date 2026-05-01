-- Remove the PS Services appointment-setting feature entirely.
-- ps_call_log must be dropped first because it has a FK to comm_solar_appointments.
DROP TABLE IF EXISTS ps_call_log;
DROP TABLE IF EXISTS comm_solar_appointments;
DROP TABLE IF EXISTS ps_clients;
DROP TABLE IF EXISTS ps_ad_accounts;
