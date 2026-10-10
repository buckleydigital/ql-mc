/**
 * jarvis-content - the editor and the print shop for Jarvis's social posts.
 *
 * Jarvis writes a post; this decides whether it is good enough to show you,
 * and if it is, draws the branded card image for it. It is deliberately NOT
 * connected to Facebook, Instagram or any account: a post ends as an image and
 * a caption on the Posts screen, and you post it yourself.
 *
 * Why an editor at all. A model asked for "a social post" writes slop - hype
 * words, invented stats, a hook that could be about anything. So a draft only
 * gets saved after passing three gates, cheapest first:
 *
 *   1. lint     - deterministic: banned AI-tell phrases, emoji and hashtag
 *                 walls, a client's name, and any number that is not in the
 *                 facts the draft declares. Free, and no model can argue it.
 *   2. editor   - a second model with the content brief, your own approved
 *                 posts and edits as the voice to match, and a strict rubric.
 *                 It returns scores and concrete fixes, never a rewrite.
 *   3. the bar  - decided here in code from the scores, not by the model's own
 *                 verdict. Only truth blocks: a hard fail, or truthful under
 *                 7, sends the draft back. Anything true is saved for you,
 *                 with the editor's score and notes; under the quality bar
 *                 (every score 6+, average 7+) it is marked as needing work.
 *
 * Why the quality scores advise rather than block: a strict editor turned
 * down true, usable posts three times running over taste ("not specific
 * enough"), so you saw nothing at all. You approve every post anyway; you
 * should see the draft and the critique, and decide.
 *
 * Actions (POST, JSON):
 *   { action: 'brief' }                       the brief, voice examples, recent topics
 *   { action: 'draft', caption, card, facts, platforms?, source?, post_id? }
 *   { action: 'render', post_id }             redraw a saved post's card
 *
 * Callers: jarvis-chat's tools (service-role key, proven by a capability test,
 * the same pattern as jarvis-notify) or a signed-in operator.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.115.0'
import { initWasm, Resvg } from 'npm:@resvg/resvg-wasm@2.6.2'
import jpeg from 'npm:jpeg-js@0.4.4'

// deno-lint-ignore no-explicit-any
type Db = any

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// ── Brand ──────────────────────────────────────────────────────────────────
// For the post images only; the app keeps its own look.
const ACCENT = '#4797ff'
const BG = '#000000'
const MUTED = '#a3a3ad'
const RULE = '#1f1f24'
// Fonts, the logo and the renderer's wasm are served from the site itself, so
// a card never depends on a third-party CDN being up.
const ASSET_BASE = (Deno.env.get('JARVIS_ASSET_BASE') ?? 'https://mc.quoteleadshq.com').replace(/\/+$/, '')

// ── The brief ──────────────────────────────────────────────────────────────
// Used when Jarvis settings has no content brief. It is a starting point, and
// the settings screen says so: who you are talking to is your call, not his.
const DEFAULT_BRIEF = `Audience: owners of Australian trade businesses, mainly solar installers, who buy leads or are weighing it up. Busy, sceptical of marketing, have been burned by bad lead providers and shared lead sites.

What QuoteLeads sells (established facts: a post may state these without listing them as facts, and cite "content brief" as the source for any number in them):
- The Branded Lead Gen System, built into the installer's own business: Meta and Google ad campaigns on the installer's own ad accounts, under their brand; a branded landing page and survey funnel that pre-qualifies homeowners; tracking; an AI SMS agent; and a CRM pipeline. They own all of it.
- Every enquiry is exclusive to that installer, never shared with competitors.
- The AI SMS agent texts every new enquiry back in under 3 seconds, from the installer's own number and in their business name. The default first text: "Hi, thanks for reaching out to [business]. We just wanted to confirm you're looking for a [trade] quote - is that correct?"
- The AI keeps the conversation going until the installer is free: it confirms the homeowner is interested and either tells them the team will call shortly, books a callback or a site visit, or gathers job details for a rough estimate, depending on how the installer sets it up. The installer gets an email when it books a callback. It never quotes prices, and it hands complaints and billing questions to a person.
- Built and live in 24 to 48 hours. A one-off build: $2,500 + GST for one campaign, service area and offering, or $5,000 + GST for bigger setups (more than $100 a day in ad spend, several campaigns, areas or offerings). Ad spend is paid directly to Meta and Google from the installer's own account, from about $50 a day, never through us. Optional monthly management, from $690 a month + GST ($1,200 for the bigger build). No lock-in.
- Pay per lead is also available: we run the ads and deliver exclusive leads to the installer as they come in.

Voice: plain Australian English. Direct, calm, confident, no hype. Someone who knows marketing talking to someone who runs a trade business. Short sentences. Specific over clever.
Every post: one idea. Either something an installer can use, a true proof point from our own numbers, or how the system actually works. End with a low-key call to action at most.
Never: name a client or a lead, show a client's own figures, invent a number, a result or a testimonial, promise outcomes (sales, jobs, ROI).
Post types: proof (real aggregate results), lessons (speed to reply, follow-up, quoting), behind the scenes (how the system generates and answers enquiries), offers (only when the owner supplies one).`

// Phrases that mark a post as machine-written. Any one fails the draft.
const BANNED: RegExp[] = [
  /game[- ]?changer/i, /\bunlock(s|ing)?\b/i, /\belevate(s|d)?\b/i, /\bdelve\b/i, /in today'?s\b/i,
  /fast[- ]paced/i, /next level/i, /revolutioni[sz]/i, /\bseamless(ly)?\b/i, /supercharg/i, /skyrocket/i,
  /look no further/i, /are you tired of/i, /got you covered/i, /say goodbye to/i, /\bdive in(to)?\b/i,
  /\bharness(ing)?\b/i, /\bleverag(e|ing)\b/i, /\bempower/i, /\bthrilled\b/i, /\bexcited to (announce|share)/i,
  /\bin the world of\b/i, /\bwhether you'?re\b/i, /\bit'?s not just\b/i, /\bembark\b/i, /\btapestry\b/i,
  /\bboost your\b/i, /\bgrow your business\b/i, /\bdon'?t miss out\b/i, /\bact now\b/i,
]

// ── Auth ───────────────────────────────────────────────────────────────────

async function authorised(req: Request, admin: Db) {
  const bearer = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  if (!bearer) return false
  // Service role: can read a table that is revoked from everyone else.
  const caller = createClient(Deno.env.get('SUPABASE_URL')!, bearer)
  const { error: capErr } = await caller.from('jarvis_posts').select('id').limit(1)
  if (!capErr) return true
  // Otherwise a signed-in operator - never a rep or a lead buyer.
  const { data: { user } } = await admin.auth.getUser(bearer)
  const acct = (user?.app_metadata as Record<string, unknown> | undefined)?.account_type
  return !!user && acct !== 'sales_rep' && acct !== 'lead_buyer'
}

// ── Gate 1: lint ───────────────────────────────────────────────────────────

type Fact = { claim: string; source: string }
type Card = {
  style: 'stat' | 'tip' | 'quote'
  kicker?: string
  stat?: string
  headline: string
  body?: string
  attribution?: string
}

const cardText = (c: Card) => [c.kicker, c.stat, c.headline, c.body, c.attribution].filter(Boolean).join(' \n ')
const numbersIn = (s: string) =>
  (s.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''))

function lint(caption: string, card: Card, facts: Fact[], clientNames: string[], brief = ''): string[] {
  const problems: string[] = []
  const all = `${caption}\n${cardText(card)}`

  for (const re of BANNED) {
    const m = all.match(re)
    if (m) problems.push(`Uses "${m[0]}" - a stock marketing/AI phrase. Say the specific thing instead.`)
  }
  const emoji = all.match(/\p{Extended_Pictographic}/gu) ?? []
  if (emoji.length > 1) problems.push(`${emoji.length} emoji. One at most, and only if it earns its place.`)
  const tags = caption.match(/#\w+/g) ?? []
  if (tags.length > 3) problems.push(`${tags.length} hashtags. Three at most.`)
  if ((all.match(/!/g) ?? []).length > 1) problems.push('More than one exclamation mark. Let the content carry it.')
  if (/[\u2013\u2014]/.test(all)) problems.push('Uses an em or en dash. Never use them: a full stop, a comma or a plain hyphen instead.')

  // Every number must be one he can point to. Normalised so "1,200" matches
  // "1200", and checked against the facts' text as written.
  // The brief's own figures (price, build time, reply time) count as sourced.
  const factText = `${facts.map((f) => `${f.claim} ${f.source}`).join(' ')} ${brief}`.replace(/,/g, '')
  const factNums = new Set(numbersIn(factText))
  for (const n of new Set(numbersIn(all))) {
    if (!factNums.has(n)) problems.push(`The number ${n} is not in the facts or the content brief. Add where it came from, or remove it.`)
  }
  for (const f of facts) {
    if (!f?.claim || !f?.source) problems.push('Every fact needs both a claim and a source.')
  }

  const lower = all.toLowerCase()
  for (const name of clientNames) {
    if (name.length >= 4 && lower.includes(name.toLowerCase())) {
      problems.push(`Names a client ("${name}"). Public posts never name clients.`)
    }
  }

  if (!['stat', 'tip', 'quote'].includes(card.style)) problems.push('card.style must be stat, tip or quote.')
  if (!card.headline?.trim()) problems.push('The card needs a headline.')
  if ((card.headline ?? '').length > 90) problems.push('Card headline over 90 characters - it will not read at a glance.')
  if ((card.body ?? '').length > 170) problems.push('Card body over 170 characters - the caption is for detail.')
  if ((card.kicker ?? '').length > 32) problems.push('Kicker over 32 characters.')
  if (card.style === 'stat' && (!card.stat || card.stat.length > 9)) problems.push('A stat card needs a stat of 9 characters or fewer, e.g. "3 sec", "98%".')
  if (card.style === 'quote' && !card.attribution) problems.push('A quote card needs an attribution, and the quote must be real and approved for use.')
  if (caption.length > 2200) problems.push('Caption over 2200 characters.')
  return problems
}

// ── Gate 2: the editor ─────────────────────────────────────────────────────

const RUBRIC = ['specific', 'truthful', 'audience', 'hook', 'voice', 'clarity', 'card'] as const

const EDITOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'hard_fails', 'issues', 'fixes'],
  properties: {
    scores: {
      type: 'object',
      additionalProperties: false,
      required: [...RUBRIC],
      properties: Object.fromEntries(RUBRIC.map((k) => [k, { type: 'integer' }])),
    },
    hard_fails: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
    fixes: { type: 'array', items: { type: 'string' } },
  },
}

const EDITOR_SYSTEM = `You are the editor for a small Australian lead-generation business's social posts. Your job is to stop mediocre or untrue posts reaching the owner, and to say exactly how to fix the rest. The owner reads and approves every post before it goes anywhere, so you are a quality filter, not the last line of defence. Be specific and unsentimental; you are protecting the brand from sounding like every other marketing account. Score what is on the page, not what an ideal post might have had.

The content brief describes what the business sells. Treat it as established fact: a claim that matches the brief is supported, whether or not the draft lists it under facts. Only a claim that goes beyond the brief and the listed facts is unsupported.

Score each 1-10:
- specific: concrete, particular detail a reader could not have guessed. Generic advice that fits any business scores 4 or less.
- truthful: every claim and number is supported by the content brief or the listed facts, and none is stretched (e.g. "all" when facts say 98%, "your phone" when delivery can be email). Any unsupported claim caps this at 3.
- audience: speaks to a trade business owner's real problem, in their terms.
- hook: the first line earns the second. Questions like "Want more leads?" and restating the topic score 3 or less.
- voice: matches the brief and the owner's own approved posts and edits (if there are none yet, judge against the brief alone and do not mark down for it). Hype, corporate filler, or anything that reads machine-written scores 4 or less.
- clarity: one idea, no padding, short sentences, easy on a phone.
- Any em dash or en dash is an issue: say to replace it with a full stop, a comma or a plain hyphen.
- card: the image text reads in two seconds and adds something the caption does not just repeat.

hard_fails: anything that must never be published - an invented or unsupported number, result or testimonial; a client or lead named or identifiable; a promise of outcomes; anything misleading. Empty if none.
issues: what is wrong, concretely, quoting the words.
fixes: exact instructions for the rewrite, most important first. Ask only for what can be fixed from the brief and the facts; never ask for information the draft could not have. Never write the post yourself.`

// ── OpenAI, the fallback ───────────────────────────────────────────────────
// When Claude cannot review (no ANTHROPIC_API_KEY, no credit, rate limited,
// down) and OPENAI_API_KEY is set, OpenAI reviews with the same prompt and
// schema. Plain fetch, no SDK; a copy of outreach-qualify's, inlined because
// this project deploys one file per function.

const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') ?? 'gpt-5.5'
/** gpt-5.5 list price, US dollars per million tokens. A cheaper model over-reports, never hides. */
const OPENAI_PRICE = { input: 5, output: 30, read: 0.5 }

/** One structured-output call: JSON text that fits `schema`, or a thrown error. */
async function askOpenAI(system: string, user: string, schema: object, effort: 'low' | 'medium') {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key) throw new Error('OPENAI_API_KEY is not set')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning_effort: effort,
      max_completion_tokens: 8000,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
      messages: [{ role: 'developer', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${String(body?.error?.message ?? '').slice(0, 200)}`)
  const choice = body.choices?.[0]
  // prompt_tokens includes the cached ones; Claude's input_tokens does not.
  const read = Number(body.usage?.prompt_tokens_details?.cached_tokens ?? 0)
  const input = Number(body.usage?.prompt_tokens ?? 0) - read
  const output = Number(body.usage?.completion_tokens ?? 0)
  return {
    text: String(choice?.message?.content ?? ''),
    refused: Boolean(choice?.message?.refusal),
    truncated: choice?.finish_reason === 'length',
    model: String(body.model ?? OPENAI_MODEL),
    input, output, read,
    cost: (input * OPENAI_PRICE.input + output * OPENAI_PRICE.output + read * OPENAI_PRICE.read) / 1e6,
  }
}

async function review(
  client: Anthropic | null,
  brief: string,
  examples: { caption: string; original_caption: string | null }[],
  draft: { caption: string; card: Card; facts: Fact[]; platforms: string[] },
) {
  const voice = examples.length
    ? examples.map((e, i) =>
        e.original_caption
          ? `Example ${i + 1} - the owner rewrote Jarvis's draft.\nJarvis wrote:\n${e.original_caption}\nOwner's version:\n${e.caption}`
          : `Example ${i + 1} - approved as written:\n${e.caption}`,
      ).join('\n\n')
    : '(none yet)'

  const user =
    `CONTENT BRIEF\n${brief}\n\n` +
    `THE OWNER'S VOICE - approved posts and the owner's edits, newest first\n${voice}\n\n` +
    `DRAFT FOR ${draft.platforms.join(' + ')}\n` +
    `Caption:\n${draft.caption}\n\n` +
    `Card (${draft.card.style}):\n${cardText(draft.card)}\n\n` +
    `Facts the draft rests on:\n${draft.facts.map((f) => `- ${f.claim} [source: ${f.source}]`).join('\n') || '(none)'}`

  type Verdict = {
    scores: Record<(typeof RUBRIC)[number], number>
    hard_fails: string[]; issues: string[]; fixes: string[]
  }

  if (client) {
    try {
      const res = await client.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 4000,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: EDITOR_SCHEMA } },
        system: EDITOR_SYSTEM,
        messages: [{ role: 'user', content: user }] as any,
      } as any)
      const text = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('')
      const u = res.usage as any
      const input = Number(u?.input_tokens ?? 0), output = Number(u?.output_tokens ?? 0)
      return {
        verdict: JSON.parse(text) as Verdict,
        model: String((res as any).model ?? 'claude-opus-5-5'),
        input, output,
        read: Number(u?.cache_read_input_tokens ?? 0),
        write: Number(u?.cache_creation_input_tokens ?? 0),
        cost: (input * 4 + output * 20) / 1e6,
      }
    } catch (err) {
      if (!(err instanceof Anthropic.APIError) || !Deno.env.get('OPENAI_API_KEY')) throw err
      console.warn(`jarvis-content: Claude API ${err.status ?? ''} (${(err.message || '').slice(0, 200)}) - reviewing with OpenAI`)
    }
  }

  const r = await askOpenAI(EDITOR_SYSTEM, user, EDITOR_SCHEMA, 'medium')
  if (r.refused) throw new Error('The OpenAI editor refused to review this draft.')
  if (r.truncated) throw new Error('The OpenAI editor was cut off before finishing.')
  return { verdict: JSON.parse(r.text) as Verdict, model: r.model, input: r.input, output: r.output, read: r.read, write: 0, cost: r.cost }
}

// ── The card ───────────────────────────────────────────────────────────────

let wasmReady: Promise<void> | null = null
let assets: Promise<{ fonts: Uint8Array[]; logo: string }> | null = null

async function fetchBytes(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`asset ${url}: ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

function loadAssets() {
  wasmReady ??= initWasm(fetch(`${ASSET_BASE}/assets/jarvis/resvg.wasm`)).catch((e) => {
    wasmReady = null
    throw e
  })
  assets ??= (async () => {
    const fonts = await Promise.all(
      ['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold'].map((w) =>
        fetchBytes(`${ASSET_BASE}/assets/jarvis/Poppins-${w}.ttf`)),
    )
    const png = await fetchBytes(`${ASSET_BASE}/quoteleads-logo-white.png`)
    let bin = ''
    for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000))
    return { fonts, logo: btoa(bin) }
  })().catch((e) => {
    assets = null
    throw e
  })
  return Promise.all([wasmReady, assets]).then(([, a]) => a)
}

const esc = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!))

/** Greedy word wrap on an estimated advance width - Poppins runs about 0.56em. */
function wrap(text: string, size: number, maxW: number, k: number) {
  const per = Math.max(4, Math.floor(maxW / (size * k)))
  const lines: string[] = []
  let line = ''
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w
    if (next.length > per && line) { lines.push(line); line = w } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** The biggest size, from `sizes`, at which the text fits in `maxLines`. */
function fit(text: string, sizes: number[], maxW: number, maxLines: number, k: number) {
  for (const s of sizes) {
    const lines = wrap(text, s, maxW, k)
    if (lines.length <= maxLines) return { size: s, lines }
  }
  const s = sizes[sizes.length - 1]
  return { size: s, lines: wrap(text, s, maxW, k).slice(0, maxLines) }
}

export function cardSvg(card: Card, logo: string) {
  const W = 1080, H = 1350, X = 96, MAXW = W - 2 * X
  const parts: string[] = []
  const lines = (ls: string[], y: number, size: number, lh: number, attrs: string) =>
    ls.map((l, i) => `<text x="${X}" y="${y + i * lh}" font-size="${size}" ${attrs}>${esc(l)}</text>`).join('')

  if (card.kicker) {
    parts.push(`<text x="${X}" y="200" font-size="28" font-weight="600" fill="${ACCENT}" letter-spacing="5">${esc(card.kicker.toUpperCase())}</text>`)
  }

  let y: number
  if (card.style === 'stat') {
    const statSize = card.stat && card.stat.length > 6 ? 190 : 260
    parts.push(`<text x="${X - 8}" y="470" font-size="${statSize}" font-weight="800" fill="${ACCENT}" letter-spacing="-8">${esc(card.stat ?? '')}</text>`)
    y = 620
    const h = fit(card.headline, [64, 58, 52], MAXW, 4, 0.6)
    parts.push(lines(h.lines, y, h.size, h.size * 1.25, 'font-weight="700" fill="#ffffff"'))
    y += h.lines.length * h.size * 1.25 + 40
  } else if (card.style === 'quote') {
    parts.push(`<text x="${X - 10}" y="440" font-size="300" font-weight="800" fill="${ACCENT}">“</text>`)
    y = 430
    const q = fit(card.headline, [60, 54, 48, 44], MAXW, 7, 0.55)
    parts.push(lines(q.lines, y, q.size, q.size * 1.3, 'font-weight="600" fill="#ffffff"'))
    y += q.lines.length * q.size * 1.3 + 30
    if (card.attribution) {
      parts.push(`<text x="${X}" y="${y}" font-size="32" font-weight="500" fill="${ACCENT}">${esc(`- ${card.attribution}`)}</text>`)
      y += 70
    }
  } else {
    y = 360
    const h = fit(card.headline, [96, 86, 76, 68], MAXW, 5, 0.55)
    parts.push(lines(h.lines, y, h.size, h.size * 1.15, 'font-weight="800" fill="#ffffff" letter-spacing="-1"'))
    y += h.lines.length * h.size * 1.15 + 50
  }

  if (card.body) {
    const b = fit(card.body, [38, 34], MAXW, 4, 0.55)
    parts.push(lines(b.lines, y, b.size, b.size * 1.47, `font-weight="400" fill="${MUTED}"`))
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Poppins">
<defs><radialGradient id="g" cx="0.85" cy="0.1" r="0.8"><stop offset="0" stop-color="${ACCENT}" stop-opacity="0.28"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/></radialGradient></defs>
<rect width="100%" height="100%" fill="${BG}"/><rect width="100%" height="100%" fill="url(#g)"/>
${parts.join('\n')}
<rect x="${X}" y="${H - 190}" width="${MAXW}" height="2" fill="${RULE}"/>
<image href="data:image/png;base64,${logo}" x="${X}" y="${H - 150}" width="230" height="81"/>
</svg>`
}

export async function renderJpeg(card: Card) {
  const { fonts, logo } = await loadAssets()
  const r = new Resvg(cardSvg(card, logo), {
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Poppins' },
    fitTo: { mode: 'width', value: 1080 },
  }).render()
  return jpeg.encode({ data: r.pixels, width: r.width, height: r.height }, 92).data as Uint8Array
}

async function renderAndStore(admin: Db, id: string, card: Card) {
  const bytes = await renderJpeg(card)
  const path = `posts/${id}.jpg`
  const { error } = await admin.storage.from('jarvis-content').upload(path, bytes, {
    contentType: 'image/jpeg', upsert: true,
  })
  if (error) throw new Error(`image upload: ${error.message}`)
  const { data } = admin.storage.from('jarvis-content').getPublicUrl(path)
  // Versioned, so a re-rendered card is not served from a stale cache.
  return `${data.publicUrl}?v=${Date.now()}`
}

// ── Handler ────────────────────────────────────────────────────────────────

async function context(admin: Db) {
  const [{ data: s }, { data: approved }, { data: recent }, { data: clients }] = await Promise.all([
    admin.from('business_settings').select('jarvis_content_brief').limit(1).maybeSingle(),
    admin.from('jarvis_posts').select('caption, original_caption')
      .in('status', ['approved', 'posted']).order('approved_at', { ascending: false }).limit(6),
    admin.from('jarvis_posts').select('caption, card, status, created_at')
      .neq('status', 'rejected').order('created_at', { ascending: false }).limit(12),
    admin.from('clients').select('company_name').limit(1000),
  ])
  return {
    brief: (s?.jarvis_content_brief as string | null)?.trim() || DEFAULT_BRIEF,
    briefIsDefault: !(s?.jarvis_content_brief as string | null)?.trim(),
    examples: (approved ?? []) as { caption: string; original_caption: string | null }[],
    recent: (recent ?? []).map((p: any) => ({
      first_line: String(p.caption).split('\n')[0].slice(0, 140),
      headline: p.card?.headline ?? null,
      status: p.status,
      created_at: p.created_at,
    })),
    clientNames: ((clients ?? []) as { company_name: string | null }[])
      .map((c) => String(c.company_name ?? '').trim()).filter(Boolean),
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  if (!(await authorised(req, admin))) return json({ error: 'Unauthorized' }, 401)

  try {
    const body = await req.json().catch(() => ({}))

    if (body.action === 'brief') {
      const c = await context(admin)
      return json({
        brief: c.brief,
        brief_is_default: c.briefIsDefault,
        voice_examples: c.examples,
        recent_posts: c.recent,
        rules: 'Every number needs a fact with its source; anything stated in the brief can cite "content brief". No client names. Card styles: stat (stat <= 9 chars + headline), tip (headline), quote (real, approved quote + attribution). Headline <= 90 chars, body <= 170.',
      })
    }

    if (body.action === 'render') {
      const { data: post } = await admin.from('jarvis_posts').select('id, card').eq('id', body.post_id).maybeSingle()
      if (!post?.card) return json({ error: 'No such post, or it has no card.' }, 404)
      const image_url = await renderAndStore(admin, post.id, post.card as Card)
      await admin.from('jarvis_posts').update({ image_url, updated_at: new Date().toISOString() }).eq('id', post.id)
      return json({ image_url })
    }

    if (body.action !== 'draft') return json({ error: 'Unknown action' }, 400)

    // A revision of an existing draft keeps anything not resent.
    let existing: any = null
    if (body.post_id) {
      const { data } = await admin.from('jarvis_posts').select('*').eq('id', body.post_id).maybeSingle()
      if (!data) return json({ error: 'No such post.' }, 404)
      if (!['draft'].includes(data.status)) return json({ error: `That post is ${data.status}; only drafts can be revised.` }, 409)
      existing = data
    }
    const caption = String(body.caption ?? existing?.caption ?? '').trim()
    const card = (body.card ?? existing?.card) as Card | null
    const facts = (Array.isArray(body.facts) ? body.facts : existing?.facts ?? []) as Fact[]
    const platforms = (Array.isArray(body.platforms) && body.platforms.length
      ? body.platforms : existing?.platforms ?? ['facebook', 'instagram']).map(String)
    if (!caption || !card) return json({ error: 'caption and card are required' }, 400)

    const ctx = await context(admin)

    // Gate 1.
    const problems = lint(caption, card, facts, ctx.clientNames, ctx.brief)
    if (problems.length) {
      return json({
        accepted: false, stage: 'lint', issues: problems,
        fixes: ['Fix every issue above, then call again with the whole revised post.'],
      })
    }

    // Gate 2.
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey && !Deno.env.get('OPENAI_API_KEY')) {
      return json({ error: 'Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set' }, 500)
    }
    const { verdict, model, ...use } = await review(apiKey ? new Anthropic({ apiKey }) : null, ctx.brief, ctx.examples, {
      caption, card, facts, platforms,
    })

    // The editor is part of the bill, so it is costed like everything else.
    await admin.from('jarvis_usage').insert({
      channel: 'editor', model, outcome: 'reviewed', steps: 1,
      input_tokens: use.input, output_tokens: use.output,
      cache_read_tokens: use.read, cache_write_tokens: use.write,
      cost_usd: Math.round(use.cost * 1e6) / 1e6,
    }).then(() => {}, () => {})

    // Gate 3: the bar, in code.
    const scores = RUBRIC.map((k) => Number(verdict.scores?.[k] ?? 0))
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length
    // Truth is the only thing that blocks. The quality scores are advice for
    // the owner, who reads and can edit every post before it goes anywhere.
    const truthful = Number(verdict.scores?.truthful ?? 0)
    const truthOk = verdict.hard_fails.length === 0 && truthful >= 7
    const meetsBar = truthOk && Math.min(...scores) >= 6 && avg >= 7
    const scoreLine = RUBRIC.map((k, i) => `${k} ${scores[i]}`).join(', ')

    if (!truthOk) {
      return json({
        accepted: false, stage: 'editor',
        score: Math.round(avg * 10) / 10, scores: verdict.scores,
        hard_fails: verdict.hard_fails, issues: verdict.issues, fixes: verdict.fixes,
        bar: 'Nothing untrue or unpublishable: no hard fails, and truthful at least 7. Cut or rephrase the claims it names.',
      })
    }

    // True: save it, then draw the card. Below the quality bar it is saved
    // all the same, with the editor's fixes in the notes for the owner.
    const notes = [
      meetsBar ? '' : 'Editor: could be stronger.',
      verdict.issues.length ? `Issues: ${verdict.issues.join(' ')}` : '',
      !meetsBar && verdict.fixes.length ? `Suggested fixes: ${verdict.fixes.join(' ')}` : '',
      `(${scoreLine})`,
    ].filter(Boolean).join('\n')
    const row = {
      caption, card, facts, platforms,
      editor_score: Math.round(avg * 10) / 10,
      editor_notes: notes.slice(0, 2000),
      source: body.source ?? existing?.source ?? null,
      updated_at: new Date().toISOString(),
    }
    let id: string
    if (existing) {
      await admin.from('jarvis_posts').update(row).eq('id', existing.id)
      id = existing.id
    } else {
      const { data, error } = await admin.from('jarvis_posts').insert(row).select('id').single()
      if (error) throw new Error(error.message)
      id = data.id
    }

    let image_url: string | null = null
    let image_error: string | null = null
    try {
      image_url = await renderAndStore(admin, id, card)
      await admin.from('jarvis_posts').update({ image_url }).eq('id', id)
    } catch (err) {
      image_error = (err as Error).message
    }

    return json({
      accepted: true, needs_work: !meetsBar, post_id: id, score: row.editor_score, scores: verdict.scores,
      notes: verdict.issues, fixes: meetsBar ? [] : verdict.fixes, image_url, image_error,
      next: meetsBar
        ? 'Saved as a draft on the Posts screen for the owner to approve. Nothing is published anywhere.'
        : 'Saved as a draft on the Posts screen, with the editor\'s notes, for the owner to judge. If you can act on the fixes ' +
          'with what you already know, revise ONCE with this post_id; otherwise stop. Either way, tell the owner it is on the ' +
          'Posts screen. Never ask the owner for facts just to satisfy the editor.',
    })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
