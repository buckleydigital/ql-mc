/**
 * jarvis-voice - retired.
 *
 * This used to render a spoken line through ElevenLabs. ElevenLabs is no longer
 * used: calls speak in Twilio's own Polly neural voice, which is included in the
 * call price, and the panel uses the browser's speech synthesis.
 *
 * The body is emptied rather than the file simply deleted, because deleting a
 * function from the repo does not undeploy it - the previous version would have
 * stayed live, holding the ElevenLabs credential and ready to bill the moment
 * that secret reappeared. This replaces it with something that cannot.
 *
 * Safe to delete outright once the function is removed in the Supabase
 * dashboard (Edge Functions -> jarvis-voice -> Delete). Nothing calls it: the
 * panel's caller was removed in the same change.
 */

Deno.serve(() =>
  new Response(
    JSON.stringify({ available: false, retired: 'ElevenLabs is no longer used.' }),
    // 410, not 404: the endpoint existed and is deliberately gone, which is a
    // different thing from a typo in a URL.
    { status: 410, headers: { 'Content-Type': 'application/json' } },
  )
)
