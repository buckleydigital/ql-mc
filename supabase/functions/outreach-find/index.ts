/**
 * outreach-find - finds businesses for cold outreach (stage 2).
 *
 * { action: 'run' } - only when started by hand: "Run today's search" in the
 * dashboard (outreach_run_now). There is no schedule, so nothing is spent on
 * a day nobody presses it (migration 20261007000003). For each niche that is
 * switched on:
 *
 *   1. Search  - Google Places text search, "<term> <place>", working through
 *                the niche's regions a query at a time, until the niche has
 *                its daily target of new prospects. Places already known are
 *                skipped before anything is saved; a query is marked done only
 *                once all of its results are in, and rests 90 days.
 *   2. Read    - each new prospect's website (home page, then its contact
 *                pages) for a published email. The page it was published on is
 *                kept as email_source_url: the Spam Act exemption for cold
 *                email rests on the address being conspicuously published.
 *   3. Verify  - MillionVerifier. Bad addresses are rejected here, so they
 *                never reach a sending inbox.
 *
 * Saving goes through prospect_add and the prospects trigger, which blocks
 * anyone in the pipeline, a client, opted out of SMS or on the do-not-contact
 * list. Nothing is sent from here.
 *
 * Each invocation stops well inside the time limit and calls itself again
 * with the same run id while work is left.
 *
 * { action: 'test' }         - one search, nothing saved.
 * { action: 'test_verify' }  - one MillionVerifier check, plus credits left.
 * { action: 'test_site' }    - read one website for its email, nothing saved.
 *
 * Callers present the service-role key, proven the same way jarvis-outbox
 * proves it: by reading jarvis_messages, which nothing else can.
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/** Working time per invocation; the platform limit is well above this. */
const BUDGET_MS = 100_000
/** Google searches per run, across all niches: a ceiling on spend. */
const MAX_SEARCHES = 60
/** Invocations one run may chain through before it stops for the day. */
const MAX_HOPS = 12
/** Websites read at once. */
const PARALLEL = 5
/** A query is searched again after this long, for businesses new since. */
const REST_DAYS = 90

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime

// ── Google Places ────────────────────────────────────────────────────────────

/** Only what outreach needs: each extra field group costs more per call. */
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.websiteUri',
  'places.nationalPhoneNumber', 'places.businessStatus', 'nextPageToken',
].join(',')

type Place = {
  id: string; displayName?: { text?: string }; formattedAddress?: string; websiteUri?: string
  nationalPhoneNumber?: string; businessStatus?: string
}

async function searchPlaces(query: string, pageToken?: string): Promise<{ places: Place[]; next: string | null }> {
  const key = Deno.env.get('GOOGLE_PLACES_API_KEY')
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY is not set (Supabase > Edge Functions > Secrets)')
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({ textQuery: query, regionCode: 'AU', languageCode: 'en', pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
    signal: AbortSignal.timeout(20_000),
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

/** Where a niche with no regions is searched, and what a state expands to. */
const AU_PLACES: [string, string][] = [
  ['Sydney', 'NSW'], ['Parramatta', 'NSW'], ['Penrith', 'NSW'], ['Sutherland Shire', 'NSW'], ['Northern Beaches', 'NSW'],
  ['Central Coast', 'NSW'], ['Newcastle', 'NSW'], ['Wollongong', 'NSW'], ['Port Macquarie', 'NSW'], ['Coffs Harbour', 'NSW'],
  ['Tamworth', 'NSW'], ['Orange', 'NSW'], ['Dubbo', 'NSW'], ['Bathurst', 'NSW'], ['Wagga Wagga', 'NSW'],
  ['Albury', 'NSW'], ['Lismore', 'NSW'], ['Byron Bay', 'NSW'], ['Nowra', 'NSW'], ['Maitland', 'NSW'],
  ['Melbourne', 'VIC'], ['Frankston', 'VIC'], ['Dandenong', 'VIC'], ['Mornington Peninsula', 'VIC'], ['Geelong', 'VIC'],
  ['Ballarat', 'VIC'], ['Bendigo', 'VIC'], ['Shepparton', 'VIC'], ['Mildura', 'VIC'], ['Warrnambool', 'VIC'], ['Traralgon', 'VIC'],
  ['Brisbane', 'QLD'], ['Logan', 'QLD'], ['Ipswich', 'QLD'], ['Gold Coast', 'QLD'], ['Sunshine Coast', 'QLD'],
  ['Toowoomba', 'QLD'], ['Townsville', 'QLD'], ['Cairns', 'QLD'], ['Mackay', 'QLD'], ['Rockhampton', 'QLD'],
  ['Bundaberg', 'QLD'], ['Hervey Bay', 'QLD'], ['Gladstone', 'QLD'], ['Redcliffe', 'QLD'],
  ['Perth', 'WA'], ['Joondalup', 'WA'], ['Rockingham', 'WA'], ['Mandurah', 'WA'], ['Bunbury', 'WA'],
  ['Geraldton', 'WA'], ['Kalgoorlie', 'WA'], ['Busselton', 'WA'],
  ['Adelaide', 'SA'], ['Mount Barker', 'SA'], ['Mount Gambier', 'SA'], ['Whyalla', 'SA'], ['Victor Harbor', 'SA'],
  ['Hobart', 'TAS'], ['Launceston', 'TAS'], ['Devonport', 'TAS'], ['Burnie', 'TAS'],
  ['Canberra', 'ACT'], ['Queanbeyan', 'NSW'],
  ['Darwin', 'NT'], ['Alice Springs', 'NT'],
]
const STATES = new Set(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'])

/** Every query a niche can run, places outermost so early days spread out. */
function nicheQueries(terms: string[], regions: string[]): string[] {
  const places: string[] = []
  const add = (p: string) => { if (!places.includes(p)) places.push(p) }
  if (!regions.length) AU_PLACES.forEach(([p, s]) => add(`${p} ${s}`))
  for (const r of regions) {
    const up = r.trim().toUpperCase()
    if (STATES.has(up)) AU_PLACES.filter(([, s]) => s === up).forEach(([p, s]) => add(`${p} ${s}`))
    else if (r.trim()) add(r.trim())
  }
  const out: string[] = []
  for (const p of places) for (const t of terms) out.push(`${t} ${p}`)
  return out
}

/** "56 Coolibah St, Mudjimba QLD 4564, Australia" -> suburb, state, postcode. */
function parseAddress(a?: string): { suburb: string | null; state: string | null; postcode: string | null } {
  const m = (a ?? '').match(/(?:^|,)\s*([^,]+?)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+(\d{4})\b/)
  return m ? { suburb: m[1].trim(), state: m[2], postcode: m[3] } : { suburb: null, state: null, postcode: null }
}

/**
 * Directories and social pages are not the business's own website: as a
 * "domain" they would make every Facebook-only tradie the same business.
 */
const NOT_A_WEBSITE = /(^|\.)(facebook|fb|instagram|linktr|linkedin|google|g|yellowpages|truelocal|localsearch|hipages|oneflare|yelp|airtasker|houzz|tiktok|youtube|x|twitter|wa)\.(com|me|ee|page|com\.au|site)$/i

function cleanWebsite(raw?: string): { website: string | null; listing: string | null } {
  if (!raw) return { website: null, listing: null }
  try {
    const u = new URL(raw)
    if (NOT_A_WEBSITE.test(u.hostname.replace(/^www\./, '')) || u.hostname.endsWith('.business.site')) {
      return { website: null, listing: raw }
    }
    // Drop tracking parameters (Google listings add utm_*): keep the site.
    return { website: `${u.protocol}//${u.hostname}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`, listing: null }
  } catch {
    return { website: null, listing: null }
  }
}

// ── Reading a website for its published email ───────────────────────────────

const UA = 'Mozilla/5.0 (compatible; QuoteLeads/1.0; business contact lookup)'

async function fetchPage(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null
    const html = (await res.text()).slice(0, 600_000)
    return { url: res.url || url, html }
  } catch {
    return null
  }
}

/** Cloudflare's email obfuscation: hex, first byte is the XOR key. */
function cfDecode(hex: string): string {
  const k = parseInt(hex.slice(0, 2), 16)
  let s = ''
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k)
  return s
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi
const ONE_EMAIL = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/i
const JUNK_EMAIL = /(\.(png|jpe?g|gif|svg|webp|css|js)$)|(^|@)(example|sentry|wixpress|sentry-next|domain|email|yourdomain|test)\.|noreply|no-reply|donotreply|@(godaddy|wix|squarespace|wordpress|mailchimp)\.com$/i

function extractEmails(html: string): string[] {
  const found = new Set<string>()
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) found.add(cfDecode(m[1]))
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    try { found.add(decodeURIComponent(m[1])) } catch { found.add(m[1]) }
  }
  const text = html
    .replace(/&#64;|&#x40;|&commat;/gi, '@')
    .replace(/&#46;|&#x2e;|&period;/gi, '.')
    .replace(/<[^>]+>/g, ' ')
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0])
  return [...found]
    .map((e) => e.trim().toLowerCase().replace(/^[.]+|[.]+$/g, ''))
    .filter((e) => ONE_EMAIL.test(e) && !JUNK_EMAIL.test(e) && e.length <= 120)
}

/** The address a business wants enquiries at: its own domain, a role inbox. */
function bestEmail(emails: string[], host: string): string | null {
  const site = host.replace(/^www\./, '')
  const score = (e: string) => {
    const [local, dom] = e.split('@')
    let s = 0
    if (dom === site || site.endsWith('.' + dom) || dom.endsWith('.' + site)) s += 4
    if (/^(info|admin|office|sales|hello|contact|enquiries|enquiry|quotes?|service|bookings|reception)$/.test(local)) s += 1
    if (/^(accounts|accounts?payable|billing|careers|jobs|hr|privacy|marketing|media|webmaster)$/.test(local)) s -= 6
    return s
  }
  const ranked = emails.slice().sort((a, b) => score(b) - score(a))
  return ranked[0] ?? null
}

/** Home page, then up to three contact-ish pages it links to. */
async function findPublishedEmail(website: string): Promise<{ email: string; page: string } | 'none' | 'unreachable'> {
  const home = await fetchPage(website)
  if (!home) return 'unreachable'
  const host = new URL(home.url).hostname
  const pick = (p: { url: string; html: string }) => {
    const e = extractEmails(p.html)
    const best = bestEmail(e, host)
    return best ? { email: best, page: p.url } : null
  }

  // A contact page is the clearest "published for enquiries" source, so look
  // there first when the home page links to one.
  const links: string[] = []
  for (const m of home.html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    if (!/contact|enquir|get-in-touch|quote|about/i.test(m[1])) continue
    try {
      const u = new URL(m[1], home.url)
      if (u.hostname === host && !links.includes(u.href) && u.href !== home.url) links.push(u.href)
    } catch { /* not a URL */ }
  }
  if (!links.length) links.push(new URL('/contact', home.url).href, new URL('/contact-us', home.url).href)
  for (const l of links.sort((a, b) => Number(/contact/i.test(b)) - Number(/contact/i.test(a))).slice(0, 3)) {
    const p = await fetchPage(l)
    if (!p) continue
    const hit = pick(p)
    if (hit) return hit
  }
  return pick(home) ?? 'none'
}

// ── MillionVerifier ─────────────────────────────────────────────────────────

type Verdict = 'valid' | 'risky' | 'invalid' | 'unknown'

async function verifyEmail(email: string): Promise<{ verdict: Verdict; detail: string }> {
  const key = Deno.env.get('MILLIONVERIFIER_API_KEY')
  if (!key) throw new Error('MILLIONVERIFIER_API_KEY is not set (Supabase > Edge Functions > Secrets)')
  const u = new URL('https://api.millionverifier.com/api/v3/')
  u.searchParams.set('api', key)
  u.searchParams.set('email', email)
  u.searchParams.set('timeout', '10')
  const res = await fetch(u, { signal: AbortSignal.timeout(20_000) })
  const b = await res.json().catch(() => ({})) as { result?: string; subresult?: string; error?: string }
  if (!res.ok || b.error) throw new Error(`MillionVerifier: ${b.error || res.status}`)
  const r = (b.result ?? '').toLowerCase()
  const verdict: Verdict = r === 'ok' ? 'valid'
    : r === 'catch_all' ? 'risky'
    : r === 'invalid' || r === 'disposable' ? 'invalid'
    : 'unknown'
  return { verdict, detail: [r, b.subresult].filter(Boolean).join(' / ') }
}

async function verifierCredits(): Promise<number | null> {
  const key = Deno.env.get('MILLIONVERIFIER_API_KEY')
  if (!key) return null
  const res = await fetch(`https://api.millionverifier.com/api/v3/credits?api=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10_000) })
  const b = await res.json().catch(() => ({})) as { credits?: number }
  return typeof b.credits === 'number' ? b.credits : null
}

// ── The run ─────────────────────────────────────────────────────────────────

type Stats = { searches: number; found: number; blocked: number; emails: number; no_email: number; verified: number; invalid: number; errors: string[] }
const newStats = (): Stats => ({ searches: 0, found: 0, blocked: 0, emails: 0, no_email: 0, verified: 0, invalid: 0, errors: [] })

/** Midnight in Brisbane (UTC+10, no daylight saving), as an ISO string. */
function brisbaneMidnight(): string {
  const day = 86_400_000, off = 10 * 3_600_000
  return new Date(Math.floor((Date.now() + off) / day) * day - off).toISOString()
}

type Niche = { key: string; label: string; daily_target: number; regions: string[]; search_terms: string[] }

/** Step 1 for one niche: search until today's target is met. */
async function searchNiche(db: SupabaseClient, n: Niche, stats: Stats, deadline: number): Promise<void> {
  const { count } = await db.from('prospects').select('id', { count: 'exact', head: true })
    .eq('niche_key', n.key).gte('found_at', brisbaneMidnight())
  let remaining = n.daily_target - (count ?? 0)
  if (remaining <= 0 || !n.search_terms.length) return

  const { data: done } = await db.from('outreach_queries').select('query, last_run_at, runs, added').eq('niche_key', n.key)
  const lastRun = new Map((done ?? []).map((q) => [q.query as string, q]))
  const restCutoff = Date.now() - REST_DAYS * 86_400_000
  const due = nicheQueries(n.search_terms, n.regions).filter((q) => {
    const r = lastRun.get(q)
    return !r?.last_run_at || new Date(r.last_run_at as string).getTime() < restCutoff
  })

  for (const query of due) {
    if (remaining <= 0 || Date.now() > deadline || stats.searches >= MAX_SEARCHES) return
    let token: string | undefined
    let results = 0, added = 0, complete = false
    for (let page = 0; page < 3; page++) {
      if (stats.searches >= MAX_SEARCHES || Date.now() > deadline) break
      const { places, next } = await searchPlaces(query, token)
      stats.searches++
      results += places.length

      // Skip what is already known before saving anything.
      const knownIds = new Set<string>()
      if (places.length) {
        const { data: known } = await db.from('prospects').select('google_place_id').in('google_place_id', places.map((p) => p.id))
        for (const k of known ?? []) knownIds.add(k.google_place_id as string)
      }

      for (const p of places) {
        if (remaining <= 0) break
        if (knownIds.has(p.id) || (p.businessStatus && p.businessStatus !== 'OPERATIONAL')) continue
        const { website, listing } = cleanWebsite(p.websiteUri)
        const addr = parseAddress(p.formattedAddress)
        const { data: row, error } = await db.rpc('prospect_add', {
          p: {
            niche_key: n.key, business_name: p.displayName?.text ?? 'Unknown', website,
            phone: p.nationalPhoneNumber ?? null, address: p.formattedAddress ?? null, ...addr,
            google_place_id: p.id, source: 'google_places',
            source_ref: `https://www.google.com/maps/place/?q=place_id:${p.id}`,
            meta: { query, ...(listing ? { listing_url: listing } : {}) },
          },
        })
        if (error) { stats.errors.push(`save: ${error.message}`); continue }
        const saved = (row ?? [])[0] as { status: string } | undefined
        if (!saved) continue                      // same business as an existing prospect
        added++; stats.found++; remaining--
        if (saved.status === 'blocked') stats.blocked++
      }
      if (remaining <= 0 && places.length) break  // target met mid-query: not complete
      if (!next) { complete = true; break }
      token = next
    }

    const prev = lastRun.get(query)
    await db.from('outreach_queries').upsert({
      niche_key: n.key, query, results,
      runs: (prev?.runs as number ?? 0) + (complete ? 1 : 0),
      added: (prev?.added as number ?? 0) + added,
      // Only a query whose results are all in rests; one cut short is picked
      // up again next run, where the places already saved are skipped.
      last_run_at: complete ? new Date().toISOString() : (prev?.last_run_at ?? null),
    })
  }
}

type Prospect = { id: string; website: string | null; email: string | null; status: string; meta: Record<string, unknown> }

/** Steps 2 and 3 for one prospect. */
async function enrichOne(db: SupabaseClient, p: Prospect, stats: Stats, canVerify: { ok: boolean }): Promise<void> {
  const meta = { ...(p.meta ?? {}) }
  let email = p.email
  let status = p.status

  if (!email) {
    if (!p.website) {
      await db.from('prospects').update({ status: 'rejected', status_reason: 'no website to find an email on', meta: { ...meta, enriched_at: new Date().toISOString() } }).eq('id', p.id)
      stats.no_email++
      return
    }
    const hit = await findPublishedEmail(p.website)
    const attempts = Number(meta.enrich_attempts ?? 0) + 1
    if (hit === 'unreachable' && attempts < 2) {
      await db.from('prospects').update({ meta: { ...meta, enrich_attempts: attempts } }).eq('id', p.id)
      return                                      // try again next run
    }
    if (typeof hit === 'string') {
      await db.from('prospects').update({
        status: 'rejected',
        status_reason: hit === 'none' ? 'no email published on the website' : 'website unreachable',
        meta: { ...meta, enrich_attempts: attempts, enriched_at: new Date().toISOString() },
      }).eq('id', p.id)
      stats.no_email++
      return
    }
    const { data, error } = await db.from('prospects').update({
      email: hit.email, email_source_url: hit.page, status: 'enriched', status_reason: null,
      meta: { ...meta, enrich_attempts: attempts, enriched_at: new Date().toISOString() },
    }).eq('id', p.id).select('status').single()
    if (error) {
      // 23505: another prospect already has this email or domain.
      await db.from('prospects').update({
        status: 'rejected',
        status_reason: error.code === '23505' ? 'same email as another prospect' : `could not save email: ${error.message}`,
        meta: { ...meta, enriched_at: new Date().toISOString() },
      }).eq('id', p.id)
      return
    }
    stats.emails++
    email = hit.email
    status = (data as { status: string }).status   // the trigger may have blocked it
  }

  if (status !== 'enriched' || !email || !canVerify.ok) return
  try {
    const v = await verifyEmail(email)
    const patch: Record<string, unknown> = { email_verdict: v.verdict, verified_at: new Date().toISOString(), meta: { ...meta, verify: v.detail } }
    if (v.verdict === 'invalid') { patch.status = 'rejected'; patch.status_reason = 'email failed verification'; stats.invalid++ }
    else if (v.verdict === 'valid' || v.verdict === 'risky') { patch.status = 'verified'; stats.verified++ }
    // 'unknown' stays enriched with its verdict, and is not retried
    await db.from('prospects').update(patch).eq('id', p.id)
  } catch (e) {
    // Out of credits or the service is down: stop verifying for this run.
    canVerify.ok = false
    stats.errors.push((e as Error).message)
  }
}

async function enrichPending(db: SupabaseClient, stats: Stats, deadline: number): Promise<boolean> {
  const canVerify = { ok: !!Deno.env.get('MILLIONVERIFIER_API_KEY') }
  if (!canVerify.ok) stats.errors.push('MILLIONVERIFIER_API_KEY is not set: emails found but not verified')
  const seen = new Set<string>()
  while (Date.now() < deadline) {
    // Never read yet, or found but not yet verified.
    const { data, error } = await db.from('prospects')
      .select('id, website, email, status, meta')
      .or(canVerify.ok ? 'and(status.eq.new,email.is.null),and(status.eq.enriched,email_verdict.is.null)' : 'and(status.eq.new,email.is.null)')
      .order('found_at')
      .limit(200)
    if (error) { stats.errors.push(`load: ${error.message}`); return false }
    const batch = (data as Prospect[]).filter((p) => !seen.has(p.id))
    if (!batch.length) return false
    batch.forEach((p) => seen.add(p.id))
    for (let i = 0; i < batch.length && Date.now() < deadline; i += PARALLEL) {
      await Promise.all(batch.slice(i, i + PARALLEL).map((p) => enrichOne(db, p, stats, canVerify).catch((e) => {
        stats.errors.push(`enrich: ${(e as Error).message}`)
      })))
    }
  }
  return true   // out of time with work left
}

async function run(db: SupabaseClient, bearer: string, runId: string, hop: number): Promise<void> {
  const deadline = Date.now() + BUDGET_MS
  const stats = newStats()
  let more = false

  const { data: niches } = await db.from('outreach_niches')
    .select('key, label, daily_target, regions, search_terms')
    .eq('enabled', true).gt('daily_target', 0).order('sort_order')

  for (const n of (niches ?? []) as Niche[]) {
    if (Date.now() > deadline) { more = true; break }
    try { await searchNiche(db, n, stats, deadline - 30_000) }
    catch (e) { stats.errors.push(`${n.label}: ${(e as Error).message}`) }
  }
  if (await enrichPending(db, stats, deadline)) more = true

  // Add this invocation's numbers to the run.
  const { data: cur } = await db.from('outreach_runs').select('*').eq('id', runId).single()
  const c = (cur ?? {}) as Record<string, number | string[]>
  const sum = (k: keyof Omit<Stats, 'errors'>) => Number(c[k] ?? 0) + stats[k]
  const chain = more && hop + 1 < MAX_HOPS
  await db.from('outreach_runs').update({
    searches: sum('searches'), found: sum('found'), blocked: sum('blocked'), emails: sum('emails'),
    no_email: sum('no_email'), verified: sum('verified'), invalid: sum('invalid'),
    errors: [...((c.errors as string[]) ?? []), ...stats.errors].slice(-20),
    ...(chain ? {} : { finished_at: new Date().toISOString(), note: more ? 'stopped for today with work left' : null }),
  }).eq('id', runId)

  console.log(`outreach-find ${runId} hop ${hop}: ${JSON.stringify({ ...stats, errors: stats.errors.length })}${chain ? ', continuing' : ''}`)
  if (chain) {
    await fetch(`${URL_}/functions/v1/outreach-find`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ action: 'run', trigger: 'continue', run_id: runId, hop: hop + 1 }),
    }).catch((e) => console.error('outreach-find: continue failed:', e))
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
  if (!bearer) return json({ error: 'Missing authorization' }, 401)
  const { error: capErr } = await createClient(URL_, bearer).from('jarvis_messages').select('id').limit(1)
  if (capErr) return json({ error: 'Unauthorized' }, 401)

  const input = await req.json().catch(() => ({})) as {
    action?: string; query?: string; email?: string; trigger?: string; run_id?: string; hop?: number
  }
  const db = createClient(URL_, SERVICE)

  try {
    if (input.action === 'test') {
      const { places, next } = await searchPlaces(input.query || 'solar installer Sunshine Coast QLD')
      return json({
        ok: true, found: places.length, more_pages: !!next,
        sample: places.slice(0, 5).map((p) => ({
          name: p.displayName?.text ?? null, address: p.formattedAddress ?? null,
          website: cleanWebsite(p.websiteUri).website, has_phone: !!p.nationalPhoneNumber, status: p.businessStatus ?? null,
        })),
      })
    }

    if (input.action === 'test_verify') {
      const v = await verifyEmail(input.email || 'info@google.com')
      return json({ ok: true, ...v, credits: await verifierCredits() })
    }

    if (input.action === 'test_site') {
      if (!input.query) return json({ error: 'query: a website URL' }, 400)
      return json({ ok: true, result: await findPublishedEmail(input.query) })
    }

    if (input.action === 'run') {
      let runId = input.run_id
      const hop = Number(input.hop ?? 0)
      if (!runId) {
        const { data: going } = await db.from('outreach_runs').select('id')
          .is('finished_at', null).gte('started_at', new Date(Date.now() - 15 * 60_000).toISOString()).limit(1)
        if (going?.length) return json({ ok: false, error: 'A run is already going' }, 409)
        const { data, error } = await db.from('outreach_runs').insert({ trigger: input.trigger ?? 'manual' }).select('id').single()
        if (error) throw error
        runId = (data as { id: string }).id
      }
      // Answer at once; the work carries on in the background.
      const work = run(db, bearer, runId!, hop).catch(async (e) => {
        console.error('outreach-find:', (e as Error).message)
        await db.from('outreach_runs').update({ finished_at: new Date().toISOString(), errors: [(e as Error).message] }).eq('id', runId!)
      })
      if (runtime?.waitUntil) runtime.waitUntil(work)
      else await work
      return json({ ok: true, run_id: runId })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 502)
  }
})
