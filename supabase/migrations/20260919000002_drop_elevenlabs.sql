-- Remove the ElevenLabs call path.
--
-- Calls now use Twilio's own Polly neural voice, which is included in the call
-- price. The ElevenLabs path existed to render a nicer clip and fall back to
-- Polly when it could not; with ElevenLabs out of use, that is a provider, a
-- credential, a storage bucket and a fallback branch all standing in for
-- something the call already does for free.
--
-- Removed rather than left dormant. It was gated purely on ELEVENLABS_API_KEY
-- being present, which means it would have switched itself back on - and started
-- billing - the moment that secret reappeared for any reason.
--
-- The jarvis-audio bucket is NOT dropped here. Storage refuses direct deletes
-- from storage.buckets and storage.objects (storage.protect_delete), and the
-- right answer to that is to use the Storage API or the dashboard, not to
-- disable the guard. It was confirmed empty, nothing writes to it any more, and
-- an empty private bucket costs nothing - so it is left for a human to remove in
-- the dashboard rather than worked around here. The bucket creation in
-- 20260918000005 is left alone for the same reason: rewriting an applied
-- migration makes the file disagree with what actually ran.
--
-- No data is lost either way. The clips were swept after an hour by design, and
-- what was said on each call is recorded in jarvis_notifications.body.

-- business_settings.jarvis_call_voice stays, and stops being a fallback: it is
-- now simply the voice he speaks in.
comment on column public.business_settings.jarvis_call_voice is
  'The Twilio Polly voice used for outbound calls, e.g. Polly.Brian-Neural. Included in the call price.';
