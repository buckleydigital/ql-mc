/**
 * jarvis-chat — the brain, server-side.
 *
 * The local bridge runs Claude Code on a laptop, which means JARVIS only works
 * at that desk, while that process is running. This function is the hosted
 * alternative: it runs the same tool loop against the Anthropic API, so the
 * assistant works from the deployed site on any device with nothing running
 * locally.
 *
 * The API key is a Supabase secret and never leaves the server. The browser
 * sends a question and gets an answer; it never sees the key, and it cannot
 * ask for a tool it was not offered.
 *
 * Tools come from ../_shared/quoteleads — the SAME modules the MCP server
 * hands to the local bridge, so both brains answer from one implementation.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.115.0'
import { TOOLS } from '../_shared/quoteleads/tools.mjs'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

/** Tools that change something. Withheld unless the caller opts in. */
const EFFECTFUL = /^(update|send|create|delete)_/

const SYSTEM = `You are JARVIS, speaking to the person who runs QuoteLeads.

You are spoken aloud, so length is the main constraint. Two sentences is the
ceiling in conversation; reading out data they asked for is the one exception.
No filler, no enthusiasm, no apologies. Say "Yes", never "yeah". Address them as
"sir" in roughly half your replies, never twice in one reply.

THE NUMBERS ARE NEVER FROM MEMORY. Every business fact comes from a tool. If a
tool reports nothing, that is a fact about the business: "I have no record of
it." Never estimate.

"LEADS" MEANS TWO THINGS AND THE WORDING DECIDES WHICH. "our sales pipeline",
"the pipeline", or a bare "leads" is the sales pipeline; "pay per lead" or "PPL"
is a different and larger set. get_lead_totals returns both — read out the one
they asked about.

- "How are we doing", "what are our numbers" -> get_daily_brief, one call.
- "How many leads" -> get_lead_totals. "How many closes" -> get_closes.
- "Are we ahead of goal" -> get_revenue_vs_goal.
- A name is a lead, a client, or a rep: try find_lead, then get_client_snapshot,
  then get_rep_performance.
- Anything not covered: get_schema to find the table, then query_table. Never
  say data is unavailable without trying that.
- A lead with no owner is handled by the person you are speaking to. It is never
  "unassigned".
- Read money as words: "forty-one thousand dollars", not "AUD 41000".

BEFORE ANYTHING IRREVERSIBLE — sending an email or SMS, deleting a task — say
what you are about to do and who it affects, and wait for them to confirm. Use
get_email_draft to read an email back before sending it. Never act on a lead you
matched loosely; if more than one matched, ask which.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    // Same gate as every other function here: a real signed-in user, or nothing.
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization' }, 401)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { data: { user }, error: authErr } = await admin.auth.getUser(
      authHeader.replace('Bearer ', ''),
    )
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not set' }, 500)

    const body = await req.json().catch(() => ({}))
    const messages = Array.isArray(body.messages) ? body.messages : []
    const text = String(body.text ?? '').trim()
    if (text) messages.push({ role: 'user', content: text })
    if (!messages.length) return json({ error: 'Nothing to answer' }, 400)
    if (messages.length > 40) messages.splice(0, messages.length - 40)

    // Writes are off unless the caller asks for them, mirroring the local
    // bridge's JARVIS_ALLOW_WRITES. A read-only session cannot be talked into
    // sending anything, because the tools are not on the list it is given.
    const allowWrites = body.allow_writes === true
    const available = TOOLS.filter((t) => allowWrites || !EFFECTFUL.test(t.name))
    const byName = new Map(available.map((t) => [t.name, t]))

    const client = new Anthropic({ apiKey })
    const used: string[] = []

    // The agentic loop: ask, run whatever tools come back, ask again with the
    // results, until the model answers in words. Bounded so a confused turn
    // cannot bill indefinitely.
    for (let turn = 0; turn < 8; turn++) {
      const res = await client.beta.messages.create({
        model: Deno.env.get('JARVIS_MODEL') ?? 'claude-opus-5',
        max_tokens: 8192,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        // Routes around a safety refusal instead of returning nothing.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        tools: available.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        messages,
      })

      messages.push({ role: 'assistant', content: res.content })

      if (res.stop_reason === 'refusal') {
        return json({ reply: 'I am unable to answer that.', tools: used }, 200)
      }

      if (res.stop_reason !== 'tool_use') {
        const reply = res.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('')
          .trim()
        return json({ reply, tools: used, messages }, 200)
      }

      // Every tool_use block must come back in ONE user message, including the
      // failures — dropping one ends the conversation mid-turn.
      const calls = res.content.filter((b: { type: string }) => b.type === 'tool_use')
      const results = await Promise.all(
        calls.map(async (call: { id: string; name: string; input: unknown }) => {
          used.push(call.name)
          const tool = byName.get(call.name)
          if (!tool) {
            return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `No such tool: ${call.name}` }
          }
          try {
            const out = await tool.handler(call.input ?? {})
            return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) }
          } catch (err) {
            return {
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: (err as Error).message,
            }
          }
        }),
      )
      messages.push({ role: 'user', content: results })
    }

    return json({ reply: 'That took too many steps, sir.', tools: used }, 200)
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
