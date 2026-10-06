/**
 * jarvis-voice-reply - retired.
 *
 * Jarvis used to ring the owner about urgent items and take a spoken answer
 * here. Calling was removed (6 Oct): urgent items arrive by text, which is the
 * record anyway, and the call added nothing a text did not.
 *
 * The body is emptied rather than the file deleted, because deleting a function
 * from the repo does not undeploy it - the previous version would have stayed
 * live as a public webhook that hands speech to jarvis-reply. This replaces it
 * with one that does nothing, answering Twilio with a polite hang-up in case a
 * stale call ever reaches it.
 *
 * Safe to delete outright once the function is removed in the Supabase
 * dashboard (Edge Functions -> jarvis-voice-reply -> Delete).
 */

Deno.serve(() =>
  new Response(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
    { status: 200, headers: { 'Content-Type': 'text/xml' } },
  )
)
