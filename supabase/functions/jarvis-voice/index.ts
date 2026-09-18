/**
 * jarvis-voice — the real voice, server-side.
 *
 * The browser's speechSynthesis is free and instant but sounds like a
 * satnav. This routes a line through ElevenLabs instead, which is the voice
 * the jarvis project uses.
 *
 * The key is a Supabase secret, exactly like the Anthropic one: the browser
 * posts text and receives audio, and never sees the credential. Without the
 * secret set, this returns 503 and the panel falls back to the browser voice —
 * so the site works either way and upgrades the moment the key appears.
 *
 * Standalone: no shared modules, so no build step. Deploy it directly.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// George - the deep British voice Jarvis uses by default. Still overridable
// with the ELEVENLABS_VOICE_ID secret, but set here so it works with nothing
// but an API key: a default that needs a second secret to be right is a
// default that is wrong.
const DEFAULT_VOICE = 'Y6FMJQzB8Hprka91pf7R'

// JARVIS_VOICE_ID is what the jarvis project's bridge calls it, so it is
// accepted too rather than silently ignored on a machine set up for that.
const voiceId = () =>
  Deno.env.get('ELEVENLABS_VOICE_ID') ?? Deno.env.get('JARVIS_VOICE_ID') ?? DEFAULT_VOICE

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })

  const key = Deno.env.get('ELEVENLABS_API_KEY')
  if (!key) {
    // Not an error state — the panel reads this as "use the browser voice".
    return new Response(JSON.stringify({ available: false }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const { text, probe } = await req.json().catch(() => ({}))
    if (probe) {
      // Report which voice is actually in use and what this key can reach.
      // The env var wins over the code default, so "I set the default" and
      // "the default is what plays" are different claims - this is how you
      // tell them apart without guessing.
      let voices: Array<{ name: string; voice_id: string }> = []
      try {
        const list = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } })
        if (list.ok) {
          const j = await list.json()
          voices = (j.voices ?? []).map((v: { name: string; voice_id: string }) => ({
            name: v.name, voice_id: v.voice_id,
          }))
        }
      } catch { /* diagnostics are best effort */ }
      return new Response(JSON.stringify({
        available: true,
        voice_in_use: voiceId(),
        from_env: !!(Deno.env.get('ELEVENLABS_VOICE_ID') ?? Deno.env.get('JARVIS_VOICE_ID')),
        usable_voices: voices,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // A spoken line is a sentence or two. Anything longer is not speech, and
    // synthesising it would be slow and expensive for no one's benefit.
    const line = String(text ?? '').trim().slice(0, 1200)
    if (!line) return new Response('No text', { status: 400, headers: corsHeaders })

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId()}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: line,
          // Turbo: the latency matters more than the last few percent of
          // fidelity when someone is waiting to hear an answer.
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
        }),
      },
    )

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)

      // A rejected voice id is the common case, and the useful thing to say
      // back is which voices this key CAN use — Voice Library voices are not
      // available over the API on the free tier, and some are restricted to
      // paid accounts, so a perfectly valid id can still be refused.
      let usable = ''
      try {
        const list = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } })
        if (list.ok) {
          const { voices } = await list.json()
          usable = (voices ?? [])
            .slice(0, 8)
            .map((v: { name: string; voice_id: string }) => `${v.name} (${v.voice_id})`)
            .join(', ')
        }
      } catch { /* diagnostics are best effort */ }

      return new Response(
        JSON.stringify({
          error: `ElevenLabs ${res.status}: ${detail}`,
          voice_tried: voiceId(),
          usable_voices: usable || undefined,
        }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(res.body, {
      headers: { ...corsHeaders, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
