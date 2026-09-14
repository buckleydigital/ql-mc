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

// George — the deep British voice jarvis uses by default. Override with the
// JARVIS_VOICE_ID secret to use one of your own.
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb'

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
      return new Response(JSON.stringify({ available: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // A spoken line is a sentence or two. Anything longer is not speech, and
    // synthesising it would be slow and expensive for no one's benefit.
    const line = String(text ?? '').trim().slice(0, 1200)
    if (!line) return new Response('No text', { status: 400, headers: corsHeaders })

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${Deno.env.get('JARVIS_VOICE_ID') ?? DEFAULT_VOICE}?output_format=mp3_44100_128`,
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
      const detail = (await res.text()).slice(0, 300)
      return new Response(JSON.stringify({ error: `ElevenLabs ${res.status}: ${detail}` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
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
