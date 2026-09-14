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
`JARVIS_VOICE_ID` to an ElevenLabs voice id; the default is George
(`JBFqnCBsd6RMkjVDRZzb`).

`jarvis-voice` keeps `verify_jwt` on, so only a signed-in user can reach it —
nobody outside the app can spend your ElevenLabs credits. It is standalone (no
shared modules), so it needs no build step.

**Cost.** ElevenLabs bills per character synthesised, so every spoken reply
costs a little. JARVIS answers in a sentence or two by design, which keeps this
small, and the function caps a line at 1200 characters. The 🔇 toggle stops
speech entirely when you would rather just read.
