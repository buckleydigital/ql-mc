/**
 * outreach-find - finds businesses for cold outreach (stage 2).
 *
 * So far it only does { action: 'test' }: one Google Places search, to prove
 * GOOGLE_PLACES_API_KEY works and is billed to a live project. Nothing is
 * saved. The daily find-and-verify run is added on top of this.
 *
 * Callers present the service-role key, proven the same way jarvis-outbox
 * proves it: by reading jarvis_messages, which nothing else can.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Only what outreach needs: each extra field group costs more per call. */
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.websiteUri',
  'places.nationalPhoneNumber', 'places.businessStatus', 'nextPageToken',
].join(',')

type Place = {
  id: string; displayName?: { text?: string }; formattedAddress?: string; websiteUri?: string
  nationalPhoneNumber?: string; businessStatus?: string
}

export async function searchPlaces(query: string, pageToken?: string): Promise<{ places: Place[]; next: string | null }> {
  const key = Deno.env.get('GOOGLE_PLACES_API_KEY')
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set (Supabase > Edge Functions > Secrets)')
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({ textQuery: query, regionCode: 'AU', languageCode: 'en', pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Google's own message says what is wrong (billing, API not enabled, key
    // restriction) and never contains the key.
    const e = (body as { error?: { status?: string; message?: string } }).error
    throw new Error(`Google Places ${res.status} ${e?.status ?? ''}: ${e?.message ?? 'no detail'}`)
  }
  const b = body as { places?: Place[]; nextPageToken?: string }
  return { places: b.places ?? [], next: b.nextPageToken ?? null }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!bearer) return json({ error: 'Missing authorization' }, 401)
  const { error: capErr } = await createClient(URL_, bearer).from('jarvis_messages').select('id').limit(1)
  if (capErr) return json({ error: 'Unauthorized' }, 401)

  const input = await req.json().catch(() => ({})) as { action?: string; query?: string }
  if (input.action !== 'test') return json({ error: 'Only action "test" is available yet' }, 400)

  try {
    const { places, next } = await searchPlaces(input.query || 'solar installer Sunshine Coast QLD')
    return json({
      ok: true,
      found: places.length,
      more_pages: !!next,
      sample: places.slice(0, 5).map((p) => ({
        name: p.displayName?.text ?? null,
        address: p.formattedAddress ?? null,
        website: p.websiteUri ?? null,
        has_phone: !!p.nationalPhoneNumber,
        status: p.businessStatus ?? null,
      })),
    })
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 502)
  }
})
