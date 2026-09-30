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
 * THIS FILE IS GENERATED. Edit index.template.ts for the handler, or
 * quoteleads/*.mjs for the tools, then run:
 *
 *     node tools/jarvis/build-edge.mjs
 *
 * It is one self-contained file because this project's deploy ships only the
 * entrypoint — a local import of a sibling file does not survive bundling,
 * which is why every other function here is a single file too. The modules in
 * quoteleads/ remain the editable source, and are what the MCP server imports
 * for the local bridge, so both brains run the same code.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.115.0'

/* __QUOTELEADS_TOOLS__ */


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

/**
 * Except his own notes. Remembering or forgetting a fact reaches no customer and
 * changes no number, and a read-only Jarvis that cannot be told "remember that"
 * is exactly the goldfish this was built to stop being.
 */
const ALWAYS_ALLOWED = /_memor(y|ies)$/

/**
 * Anthropic-hosted tools: they run on Anthropic's servers, not here, so he can
 * look something up on the web - a supplier, a suburb, a competitor, an award
 * rate - without this function fetching anything itself. Capped per turn so a
 * curious question cannot run up a search bill.
 */
const SERVER_TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
]

/** Rounds of tool use per question before he gives up. */
const MAX_STEPS = 16

/** How much of a panel conversation is kept. */
const MAX_HISTORY = 40

/**
 * Keep the last `max` messages, starting on a real question.
 *
 * Cutting at an arbitrary index can leave a tool_result first, answering a
 * tool_use that was cut off - and the API rejects the whole conversation. So
 * after the cut, drop forward to the first user turn that is a question.
 */
function trimHistory(messages: any[], max = MAX_HISTORY) {
  if (messages.length <= max) return messages
  let out = messages.slice(-max)
  const isQuestion = (m: any) =>
    m?.role === 'user' &&
    (typeof m.content === 'string' ||
      (Array.isArray(m.content) && !m.content.some((b: any) => b?.type === 'tool_result')))
  const start = out.findIndex(isQuestion)
  out = start === -1 ? [] : out.slice(start)
  return out
}

/** A stored transcript as lines a person can read: questions and answers only. */
function readable(messages: any[]) {
  const lines: { role: 'you' | 'jarvis'; text: string }[] = []
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      lines.push({ role: 'you', text: m.content })
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('')
        .trim()
      if (text) lines.push({ role: 'jarvis', text })
    }
  }
  return lines
}

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
is a different and larger set. get_lead_totals returns both, but ANSWER WITH ONE.
A bare "leads" question is about the sales pipeline: give that figure and stop.
Do not mention pay per lead, do not add "and none in pay per lead", do not
contrast the two. Pay per lead is reported only when they name it.

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

YOU ARE AN AGENT, NOT A SEARCH BOX. When asked to do something, do all of it:
chain as many tools as the job takes, check your own work, and report what you
did. Do not stop to ask permission for reads or lookups. If a request is vague,
make the sensible call and say what you assumed. If something fails, try
another way before reporting it.

YOU HAVE A MEMORY. What you know appears below under WHAT YOU REMEMBER, and it
carries across days, devices, texts and calls.
- When they tell you a preference, a standing instruction, a fact about a
  client, lead or rep, a goal, or say "remember", call create_memory at once,
  one fact per call, written to make sense on its own later. Do not announce it
  beyond a word like "Noted."
- When a memory turns out wrong or stale, delete_memory it and save the fix.
- Never save business numbers the tools can fetch; they go stale.
- Use what you remember without being asked: if you know Dave prefers texts,
  suggest a text.

THE WEB. web_search and web_fetch are for the outside world: a business, a
supplier, a competitor, a suburb, a regulation, a news item. Never for our own
numbers, which are only ever from the tools above.

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
    const bearer = authHeader.replace('Bearer ', '').trim()
    const body = await req.json().catch(() => ({}))

    // ── The SMS bridge ──────────────────────────────────────────────────────
    // A text arrives from Twilio, not from a browser, so there is no user token
    // to present. This is the second accepted caller, and it is narrow:
    //
    //   1. the request must say via:'sms', and
    //   2. the bearer must be able to read jarvis_messages, which is revoked
    //      from anon and authenticated and forces RLS with no policies - so
    //      only a service-role key can do it.
    //
    // A capability test rather than a string compare against the service key:
    // that comparison broke once already when the runtime's copy turned out not
    // to match the dashboard's, and it fails silently when it breaks.
    //
    // What makes this safe is upstream, not here: the only route to it is
    // twilio-inbound-sms, which accepts a message only if it was sent TO
    // Jarvis's own number AND FROM the number in jarvis_notify_number. The
    // service key is not reachable from any browser, so nothing a client can
    // run reaches this branch.
    let isBridge = false
    if (body?.via === 'sms') {
      const caller = createClient(Deno.env.get('SUPABASE_URL')!, bearer)
      const { error: capErr } = await caller.from('jarvis_messages').select('id').limit(1)
      if (capErr) return json({ error: 'Unauthorized' }, 401)
      isBridge = true
    }

    let user: { id?: string; app_metadata?: Record<string, unknown> } | null = null
    if (!isBridge) {
      const { data: { user: u }, error: authErr } = await admin.auth.getUser(bearer)
      if (authErr || !u) return json({ error: 'Unauthorized' }, 401)
      user = u
    }

    // Reps are scoped to their own leads in this app; JARVIS answers across the
    // whole business — revenue, margin, ad spend, every client, every rep's
    // numbers. account_type lives in app_metadata, which only the service role
    // can write, so it cannot be forged by the caller. This is the real
    // restriction: hiding the button in the UI is a convenience, not a control.
    const accountType = (user?.app_metadata as Record<string, unknown> | undefined)?.account_type
    if (!isBridge && (accountType === 'sales_rep' || accountType === 'lead_buyer')) {
      return json({ error: 'Not available for this account.' }, 403)
    }

    // ── The panel's conversation lives here, not in the browser ─────────────
    // A caller that sends its own `messages` (the SMS bridge) owns its history.
    // The panel sends only the new question; the thread is loaded from and
    // saved to jarvis_threads under the signed-in user, so a reload, a second
    // tab or a phone continues the same conversation.
    const userId = user?.id ?? null
    const threaded = !isBridge && !!userId && !Array.isArray(body.messages)

    const loadThread = async () => {
      const { data } = await admin
        .from('jarvis_threads').select('messages').eq('user_id', userId).maybeSingle()
      return Array.isArray(data?.messages) ? data.messages : []
    }
    const saveThread = async (msgs: unknown[]) => {
      if (!threaded) return
      const { error } = await admin.from('jarvis_threads').upsert({
        user_id: userId,
        messages: trimHistory(msgs),
        updated_at: new Date().toISOString(),
      })
      if (error) console.error('jarvis-chat: thread not saved:', error.message)
    }

    if (body.action === 'history') {
      if (!threaded) return json({ lines: [] })
      return json({ lines: readable(await loadThread()) })
    }
    if (body.action === 'reset') {
      if (threaded) await admin.from('jarvis_threads').delete().eq('user_id', userId)
      return json({ ok: true })
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not set' }, 500)

    let messages: any[] = threaded
      ? await loadThread()
      : Array.isArray(body.messages) ? body.messages : []
    const text = String(body.text ?? '').trim()
    if (text) messages.push({ role: 'user', content: text })
    if (!messages.length) return json({ error: 'Nothing to answer' }, 400)
    messages = trimHistory(messages)

    // What he remembers, read fresh every question so a fact saved by text is
    // known in the panel a second later. Best effort: a memory table that is
    // missing or down must not take the assistant with it.
    let remembered = '(nothing yet)'
    try {
      const mems = await loadMemories()
      if (mems.length) remembered = mems.map((m: { content: string }) => `- ${m.content}`).join('\n')
    } catch (err) {
      console.error('jarvis-chat: memory unavailable:', (err as Error).message)
    }
    const system = [
      // Static first, so the prompt cache can hold it across questions.
      { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text:
          `Today is ${localDate()} (${config.timezone}). ` +
          `Channel: ${isBridge ? 'sms' : 'panel'}.\n\nWHAT YOU REMEMBER:\n${remembered}`,
      },
    ]

    // Writes are off unless the caller asks for them, mirroring the local
    // bridge's JARVIS_ALLOW_WRITES. A read-only session cannot be talked into
    // sending anything, because the tools are not on the list it is given.
    const allowWrites = body.allow_writes === true
    const available = TOOLS.filter(
      (t) => allowWrites || !EFFECTFUL.test(t.name) || ALWAYS_ALLOWED.test(t.name),
    )
    const byName = new Map(available.map((t) => [t.name, t]))

    const client = new Anthropic({ apiKey })
    const used: string[] = []

    // The agentic loop: ask, run whatever tools come back, ask again with the
    // results, until the model answers in words. Bounded so a confused turn
    // cannot bill indefinitely.
    for (let turn = 0; turn < MAX_STEPS; turn++) {
      const res = await client.beta.messages.create({
        model: Deno.env.get('JARVIS_MODEL') ?? 'claude-opus-5',
        max_tokens: 8192,
        system,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        // Routes around a safety refusal instead of returning nothing.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        tools: [
          ...available.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
          ...SERVER_TOOLS,
        ],
        messages,
      })

      messages.push({ role: 'assistant', content: res.content })

      // Record the hosted tools too, so the panel shows he went to the web.
      for (const b of res.content as { type: string; name?: string }[]) {
        if (b.type === 'server_tool_use' && b.name) used.push(b.name)
      }

      if (res.stop_reason === 'refusal') {
        // Not saved: a refused turn in the stored thread would poison the next.
        return json({ reply: 'I am unable to answer that.', tools: used }, 200)
      }

      // The web tools run in a loop on Anthropic's side, which pauses after a
      // while. Sending the transcript straight back resumes it - no extra user
      // message, the trailing server_tool_use is what tells the API to carry on.
      if (res.stop_reason === 'pause_turn') continue

      if (res.stop_reason !== 'tool_use') {
        const reply = res.content
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join('')
          .trim()
        await saveThread(messages)
        return json({ reply, tools: used, messages: threaded ? undefined : messages }, 200)
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

    // Close the turn in words so the saved thread stays a valid conversation
    // and the next question does not land in the middle of a tool call.
    const giveUp = 'That took too many steps, sir. Tell me which part to do first.'
    if (messages[messages.length - 1]?.role === 'user') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: giveUp }] })
    }
    await saveThread(messages)
    return json({ reply: giveUp, tools: used }, 200)
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
