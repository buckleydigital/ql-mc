// House rule: no email or SMS we send ever contains an em dash.
//
// Importing this file for its side effect wraps fetch, so every request to
// Resend (email), Twilio's Messages endpoint (SMS) and Instantly (cold email)
// has its dashes replaced on the way out. That covers everything those
// messages are built from: copy in this repo, templates and settings saved in
// the database, text a client or rep typed, and AI output. Anything that
// replies to Twilio with TwiML instead of calling it passes its text through
// noEmDash() directly.
//
//   import '../_shared/no-em-dash.ts'
//
// Every function that sends an email or SMS must import it. ql-hq and ql-mc
// each have a copy of this file; keep the two identical.

const EM = '(?:—|―|&mdash;|&#0*8212;|&#x0*2014;|&#0*8213;|&#x0*2015;)'
const EN = '(?:–|&ndash;|&#0*8211;|&#x0*2013;)'
const RULES: Array<[RegExp, string]> = [
  // One that starts a line, as in a sign-off, becomes "- ".
  [new RegExp(`^[ \\t]*(?:${EM}|${EN})[ \\t]*`, 'gim'), '- '],
  // "word — word", "word—word" and "word – word" all read as "word - word".
  [new RegExp(`[ \\t]*${EM}[ \\t]*`, 'gi'), ' - '],
  [new RegExp(`[ \\t]+${EN}[ \\t]+`, 'gi'), ' - '],
  // A bare en dash, as in "7–14 days", becomes a hyphen.
  [new RegExp(EN, 'gi'), '-'],
]

export function noEmDash(s: string): string {
  let out = s
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}

function cleanDeep(v: unknown): unknown {
  if (typeof v === 'string') return noEmDash(v)
  if (Array.isArray(v)) return v.map(cleanDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = cleanDeep(x)
    return out
  }
  return v
}

type Kind = 'json' | 'form'

function kindFor(url: string): Kind | null {
  if (/^https:\/\/api\.resend\.com\//i.test(url)) return 'json'
  if (/^https:\/\/api\.instantly\.ai\//i.test(url)) return 'json'
  if (/^https:\/\/api\.twilio\.com\/.*\/Messages\.json/i.test(url)) return 'form'
  return null
}

function cleanBody(body: BodyInit, kind: Kind): BodyInit {
  if (body instanceof URLSearchParams) {
    const out = new URLSearchParams()
    for (const [k, v] of body) out.append(k, noEmDash(v))
    return out
  }
  if (body instanceof FormData) {
    const out = new FormData()
    for (const [k, v] of body) out.append(k, typeof v === 'string' ? noEmDash(v) : v)
    return out
  }
  if (typeof body !== 'string') return body
  if (kind === 'form') {
    const out = new URLSearchParams()
    for (const [k, v] of new URLSearchParams(body)) out.append(k, noEmDash(v))
    return out.toString()
  }
  try {
    return JSON.stringify(cleanDeep(JSON.parse(body)))
  } catch {
    return noEmDash(body.replace(/\\u201[345]/gi, (m) => JSON.parse(`"${m}"`)))
  }
}

type Fetch = typeof fetch
const MARK = '__qlNoEmDash'
const original = globalThis.fetch as Fetch & { [MARK]?: true }

if (!original[MARK]) {
  const wrapped = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const kind = kindFor(url)
    if (kind) {
      if (init?.body != null) {
        init = { ...init, body: cleanBody(init.body, kind) }
      } else if (input instanceof Request && input.body) {
        const text = await input.clone().text()
        input = new Request(input, { body: cleanBody(text, kind) as string })
      }
    }
    return original(input, init)
  }) as Fetch & { [MARK]?: true }
  wrapped[MARK] = true
  globalThis.fetch = wrapped
}
