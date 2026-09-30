# JARVIS on the hosted site

The panel in Mission Control talks to the **`jarvis-chat` edge function**, not
to anything on your laptop. That is what makes it work from
`https://buckleydigital.github.io/ql-mc/` — and from your phone — with nothing
running locally.

```
browser (the panel)        Supabase                     Anthropic
  question  ─────────────► jarvis-chat ────────────────► claude
  answer    ◄───────────── runs the QuoteLeads tools ◄───
                           against this database
```

The Anthropic key is a Supabase secret. It is read server-side inside the
function and never reaches the browser, so the page can be public without
exposing it.

## Memory

Two kinds, both in the database, both service-role only
(`20260930000001_jarvis_memory.sql`):

- **`jarvis_memory`** — durable facts he has been told ("Dave at Sandford
  prefers texts", "the goal this quarter is 60 closes"). Every question on every
  channel — panel, SMS — reads them into the prompt, so a fact saved by text is
  known in the panel a second later. He saves them himself with `create_memory`
  when told a preference or asked to remember, and corrects them with
  `delete_memory`. Business numbers are never memorised; they come from the
  tools every time.
- **`jarvis_threads`** — the panel conversation, one per signed-in user. The
  browser sends only the new question; the function loads and saves the
  transcript, so a reload or a phone carries on the same conversation. ⟲ in the
  panel starts a new one without touching what he remembers.

He also has Anthropic's hosted `web_search` and `web_fetch` tools for anything
outside the database, capped at five uses each per question.

## Scheduled jobs

He can schedule his own work: "every weekday at 8, text me the numbers",
"Thursday, chase Sandford if they have not replied". `create_job` stores an
instruction and a local time in `jarvis_jobs`; the 15-minute heartbeat
(`jarvis-notify`) claims due jobs one at a time (`jarvis_claim_due_jobs`, which
also moves each one's schedule on, so two heartbeats can never run the same job
twice), sends each to `jarvis-chat` as `via: 'job'`, and texts you the report.

Jobs obey the same quiet hours and daily text cap as alerts. A job sends an
email or SMS to a lead only if its instruction says to; otherwise it drafts and
reports, and you reply "yes". At most two run per heartbeat, 25 can be active.

The ✦ button in the panel shows what he remembers and what he has scheduled,
and lets you edit memories or cancel jobs.

## Social posts

He drafts Facebook/Instagram posts; you approve them on the ▦ Posts screen and
post them yourself. **Not connected to any social account** - there is no
publish tool, and approving publishes nothing.

Every draft goes through `jarvis-content` before you see it:

1. **Lint** (code, free): banned AI-tell phrases, emoji/hashtag walls, client
   names, and any number not listed in the draft's `facts` with a source.
2. **Editor** (a second model, Opus 5.5 at medium effort): scores specific,
   truthful, audience, hook, voice, clarity and card against the content brief
   and your own approved posts and edits.
3. **The bar**, in code: every score at least 7, average at least 8, no hard
   fails. Anything less goes back to him with the fixes.

Passing drafts get a branded 4:5 card (Poppins, black, #4797ff) rendered with
resvg-wasm into the public `jarvis-content` bucket. Fonts, the renderer's wasm
and the logo are served from this site (`assets/jarvis/`; Poppins is OFL, its
licence alongside; resvg-wasm 2.6.2 is MPL-2.0, unmodified), so a card never
depends on a third-party CDN.

The content brief lives in Jarvis settings. Edit a caption before approving
and he gets the before/after as a voice example next time.

## Cost

Every question is costed at list price and written to `jarvis_usage` - panel,
SMS, scheduled jobs and the SMS fallback in `jarvis-reply`. Settings → What he
costs shows today, this month, the average per question and last month.
Anthropic spend only; Twilio is billed separately. Prices live in `PRICES` in
`index.template.ts` - update them there if Anthropic's change.

## Model

`claude-opus-5-5` by default (`JARVIS_MODEL` overrides it). On Opus 5.5 a
thinking block is bound to the exact conversation that produced it, and this
thread changes between questions (memory in the system prompt, the read-only
switch, trimming), so thinking is stripped from the stored thread after each
question - `withoutThinking()` - and `drop_block` is set as a safety net.

## Deploy

```bash
node tools/jarvis/build-edge.mjs     # only if you changed the tools
supabase functions deploy jarvis-chat --project-ref wmegoygrancfwxagqskh
```

`index.ts` is **generated** and committed. This project's deploy ships only the
entrypoint — a local import of a sibling file does not survive bundling, which
is why every other function here is a single file too — so the function has to
be self-contained. The build concatenates `quoteleads/*.mjs` into it, and fails
loudly if two modules ever declare the same top-level name.

Edit `index.template.ts` for the handler, or `quoteleads/*.mjs` for the tools.
Never edit `index.ts` directly; the next build overwrites it.

`ANTHROPIC_API_KEY` is already set as a project secret. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are provided by the platform. Nothing else to
configure.

To confirm the secret is there:

```bash
supabase secrets list --project-ref wmegoygrancfwxagqskh
```

## One implementation, two brains

The tools live in `supabase/functions/jarvis-chat/quoteleads/`. Both brains use
them:

- **the edge function** (hosted, this document) bundles them
- **the MCP server** in `tools/jarvis/` imports them for the local jarvis
  bridge, if you ever want the subscription-backed Claude Code brain at your desk

So a fix to a query, or a new tool, applies to both. The modules read their
environment through one accessor that works in Deno and Node alike.

## Reads and writes

The panel sends `allow_writes`, and the function filters the tool list before
Claude ever sees it. With the 🔒 toggle off — the default, per browser — the
sending and changing tools are **not offered at all**, so no misheard sentence
can email a customer. Turning it on (🔓) adds them, and the system prompt makes
him state what he is about to do and wait for a yes.

Sending email or SMS from the hosted brain uses the same edge functions the app
does, which attribute the send to a rep. Set `QL_USER_EMAIL` and
`QL_USER_PASSWORD` as secrets if you want that path to work server-side.

## Cost

Each question is one or more Anthropic API calls, billed per token, against the
key in your Supabase secrets — not your Claude subscription. Short questions
answered from one tool call are cents. `get_daily_brief` does five lookups in
one call, which is the cheapest way to ask a broad question.

The loop is bounded at 8 rounds of tool calls, and the conversation at 40
messages, so a confused turn cannot bill indefinitely.

## The voice

Two engines, chosen automatically per reply:

1. **ElevenLabs** via the `jarvis-voice` function — the voice the jarvis
   project uses (George, a deep British voice). Requires an ElevenLabs key.
2. **The browser's own speech** — free, instant, and a satnav. The panel picks
   the best British male voice available (`Google UK English Male` on Chrome,
   `Daniel` on macOS) rather than the OS default.

The panel tries ElevenLabs first. If the function answers 503 — which is what
it returns when no key is set — it stops asking for the rest of the session and
uses the browser voice. So the site works with no key and upgrades the moment
one appears; nothing to toggle.

### Turning on the real voice

```bash
supabase secrets set ELEVENLABS_API_KEY=... --project-ref wmegoygrancfwxagqskh
supabase functions deploy jarvis-voice --project-ref wmegoygrancfwxagqskh
```

Reload the page and ask something. To use a different voice, set
`ELEVENLABS_VOICE_ID` to an ElevenLabs voice id; the default is George
(`JBFqnCBsd6RMkjVDRZzb`). `JARVIS_VOICE_ID` — the name the jarvis bridge uses —
is accepted as a fallback, so a machine already set up for that keeps working.

`jarvis-voice` keeps `verify_jwt` on, so only a signed-in user can reach it —
nobody outside the app can spend your ElevenLabs credits. It is standalone (no
shared modules), so it needs no build step.

**Cost.** ElevenLabs bills per character synthesised, so every spoken reply
costs a little. JARVIS answers in a sentence or two by design, which keeps this
small, and the function caps a line at 1200 characters. The 🔇 toggle stops
speech entirely when you would rather just read.
