-- Jarvis texts and rings you again, from the main Twilio number.
--
-- The panel note stays. On top of it, Jarvis settings has two switches:
--   jarvis_notify_enabled  - text new alerts to jarvis_notify_number;
--   jarvis_call_enabled    - ring that number about urgent ones.
-- Both send from twilio_from_number, the business's main number, rather than
-- jarvis_from_number (which is no longer used to send).
--
-- Which events have been dealt with on the phone is tracked apart from the
-- panel (notified_at), so quiet hours and the daily caps can hold a text
-- without holding the panel note.

alter table public.jarvis_events add column if not exists phone_handled_at timestamptz;

-- Everything already open counts as dealt with, so switching texts on does
-- not send a backlog the panel has already shown.
update public.jarvis_events set phone_handled_at = now() where phone_handled_at is null;

create index if not exists jarvis_events_phone_pending_idx
  on public.jarvis_events (first_seen_at) where phone_handled_at is null and resolved_at is null;
