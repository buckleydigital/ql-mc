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
supabase functions deploy jarvis-chat --project-ref wmegoygrancfwxagqskh
```

`ANTHROPIC_API_KEY` is already set as a project secret. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are provided by the platform. Nothing else to
configure.

To confirm the secret is there:

```bash
supabase secrets list --project-ref wmegoygrancfwxagqskh
```

## One implementation, two brains

The tools live in `supabase/functions/jarvis-chat/quoteleads/` — inside the
function's own folder, because `supabase functions deploy` uploads only the
directory being deployed; a sibling `_shared/` is not included in the bundle and
the import fails to resolve at deploy time. Both brains import them:

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
