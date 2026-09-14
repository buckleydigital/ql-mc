# QuoteLeads MCP server

The QuoteLeads database, exposed as tools an assistant can call. Built for
[JARVIS](https://github.com/adewaskar/jarvis), but it is a plain MCP server —
Claude Code, Claude Desktop, or anything else that speaks MCP can use it.

It lives here, in the repository whose schema it queries, so a migration and the
tool that reads it change together. JARVIS itself stays unmodified.

## Why not just point the assistant at Supabase?

A generic SQL tool has to rediscover 47 tables on every question, and guesses
wrong about the things that are business facts rather than schema facts — which
`stage` values count as won, that "today" means the Australian day and not UTC,
that `send-sales-email` owns the templating and the `sales_email_log` entry. The
tools here answer the questions actually asked, in one round trip, correctly.

## Install

```bash
cp tools/jarvis/.env.example tools/jarvis/.env
# add QL_SUPABASE_KEY
```

Then register it. JARVIS's bridge hands every server in `~/.claude.json` to the
brain (`configuredServers()` in `bridge/server.mjs`), so adding it there is the
whole integration — no fork, no patch:

```jsonc
// ~/.claude.json
{
  "mcpServers": {
    "quoteleads": {
      "command": "node",
      "args": [
        "--env-file=/ABSOLUTE/PATH/TO/ql-mc/tools/jarvis/.env",
        "/ABSOLUTE/PATH/TO/ql-mc/tools/jarvis/server.mjs"
      ]
    }
  }
}
```

Restart the bridge (`npm start` in the jarvis checkout) and say *"how are we
doing"*.

Finally, paste `briefing.md` into the bridge's `SYSTEM_PROMPT`. That is the only
change to jarvis itself, and it is optional — he works without it, just more
verbosely.

## Reads and writes

The bridge decides permissions by reading verbs out of tool names
(`decideTool`), so the names here are deliberate:

| | |
|---|---|
| `get_*`, `find_*` | run always, including under plain `npm run bridge` |
| `update_*`, `send_*`, `create_*` | held back unless the bridge starts with `JARVIS_ALLOW_WRITES=1` (`npm run bridge:writes`) |

That split is the safety story. In the default mode JARVIS can read every
number in the business and change nothing. Sending a customer an SMS or moving
a deal takes a deliberately different start command.

### The tools

**Ask anything** — `get_schema` lists the tables and their columns;
`query_table` reads any of them with PostgREST filters
(`{"stage":"eq.won","value":"gte.5000","suburb":"ilike.*brisbane*"}`). Together
they cover the questions nobody anticipated, which is most of them. Both are
read-only by construction — they issue GET requests, so there is no SQL string
to inject into and no verb that writes — and any column whose name looks like a
credential (`*_key`, `*_token`, `*secret*`, `*password*`) comes back redacted.

**Reads** — `get_daily_brief` (everything, one call), `get_lead_totals`,
`get_leads_today`, `get_closes`, `get_pipeline_summary`, `get_revenue_vs_goal`,
`get_ad_spend_and_cpl`, `get_rep_performance`, `get_client_snapshot`,
`find_lead`, `get_followups_due`, `get_delivery_failures`.

**Writes** — `update_lead_stage`, `update_lead_followup`, `send_lead_email`,
`send_lead_sms`, `create_task`.

The two `send_*` tools call the existing edge functions (`send-sales-email`,
`send-sms`) rather than reimplementing them, so logging and the
`info_sent_at` / `followup_sent_at` stamps stay in one place.

**Sending needs a login.** Both functions verify a *user* token
(`auth.getUser`) and attribute the send to that person — the rep's name and
reply-to address come out of the session, so a service-role key is rejected.
Set `QL_USER_EMAIL` and `QL_USER_PASSWORD` to the rep the assistant should send
as. Reads never use it; leave them unset and the read tools work while the two
`send_*` tools say what is missing.

### Curated tools vs. the fallback

Both, deliberately. The curated tools encode business rules the raw tables do
not state — which stages count as won, that "today" is the Australian day, that
CPL is spend over leads — and answer the daily questions in one round trip. The
fallback means an unanticipated question gets a real answer instead of a shrug.
The briefing tells JARVIS to prefer a purpose-built tool when one fits.

## Notes on the data

- **Dates are local.** Every "today" is computed in `QL_TIMEZONE`
  (`dates.mjs`). UTC day boundaries would report yesterday's lead count for the
  whole working morning.
- **Won and dead stages are configured, not inferred.** `leads.stage` is free
  text; `QL_WON_STAGES` and `QL_DEAD_STAGES` decide what counts.
- **`get_closes` dates a win by `updated_at`,** because `leads` has no
  `closed_at` column. Exact for a lead closed and left alone; it drifts if a won
  lead is edited in a later month. If closes-per-month becomes a number anyone
  is paid on, add a `closed_at` column and this tool should read it.
- **Zero dependencies.** PostgREST over `fetch`, and MCP implemented directly in
  `server.mjs`. Node 20+, nothing to install.

## Testing it without a voice

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_daily_brief","arguments":{}}}' \
  | node --env-file=.env server.mjs
```
