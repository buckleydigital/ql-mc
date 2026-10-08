/**
 * jarvis-chat - the brain, server-side.
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
 * entrypoint - a local import of a sibling file does not survive bundling,
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
 *
 * Post drafts likewise: a draft sits on the Posts screen until the owner
 * approves it and posts it by hand. No tool publishes anything.
 */
const ALWAYS_ALLOWED = /_memor(y|ies)$|^create_post_draft$/

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

/**
 * List prices, US dollars per million tokens, for costing each question.
 * `write` is the 5-minute cache write (1.25x input), `read` the cache read.
 * Keyed by model-id prefix; a model not listed is costed at Claude Opus 5
 * rates rather than at zero, so an unknown model over-reports, never hides.
 */
const PRICES: Record<string, { input: number; output: number; write: number; read: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, write: 5, read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, write: 6.25, read: 0.5 },
  'claude-opus-4': { input: 5, output: 25, write: 6.25, read: 0.5 },
  'claude-fable-5': { input: 10, output: 50, write: 12.5, read: 0.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, write: 2.5, read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, write: 2.5, read: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, write: 1.25, read: 0.1 },
}
const WEB_SEARCH_USD = 10 / 1000

function priceFor(model: string) {
  const key = Object.keys(PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return PRICES[key ?? 'claude-opus-5']
}

/** Running total for one question, across every step of the loop. */
function newSpend() {
  return {
    steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    searches: 0, fetches: 0, cost: 0, models: new Set<string>(),
  }
}

function addUsage(spend: ReturnType<typeof newSpend>, res: any) {
  const u = res?.usage ?? {}
  const model = String(res?.model ?? '')
  const p = priceFor(model)
  const input = Number(u.input_tokens ?? 0)
  const output = Number(u.output_tokens ?? 0)
  const read = Number(u.cache_read_input_tokens ?? 0)
  const write = Number(u.cache_creation_input_tokens ?? 0)
  const searches = Number(u.server_tool_use?.web_search_requests ?? 0)
  spend.steps += 1
  spend.input += input
  spend.output += output
  spend.cacheRead += read
  spend.cacheWrite += write
  spend.searches += searches
  spend.fetches += Number(u.server_tool_use?.web_fetch_requests ?? 0)
  if (model) spend.models.add(model)
  spend.cost +=
    (input * p.input + output * p.output + read * p.read + write * p.write) / 1e6 +
    searches * WEB_SEARCH_USD
}

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

/**
 * The thread as it is kept between questions: without the model's thinking.
 *
 * On Claude Opus 5.5 a thinking block is bound to the exact conversation that
 * produced it - system prompt, tools, every earlier message. Between questions
 * all three change here: the memory block in the system prompt grows, the
 * read-only switch changes the tool list, and the thread is trimmed from the
 * front. Replaying old thinking after any of that is a 400 on enforced
 * accounts. Removing all of it is always allowed (it is a leading run), and
 * costs nothing - earlier turns' thinking is not what the next answer needs.
 * Within one question the loop keeps its thinking, as tool use requires.
 */
function withoutThinking(messages: any[]) {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m
    const content = m.content.filter((b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking')
    return { ...m, content: content.length ? content : [{ type: 'text', text: '…' }] }
  })
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
carries across days, devices and texts.
- When they tell you a preference, a standing instruction, a fact about a
  client, lead or rep, a goal, or say "remember", call create_memory at once,
  one fact per call, written to make sense on its own later. Do not announce it
  beyond a word like "Noted."
- When a memory turns out wrong or stale, delete_memory it and save the fix.
- Never save business numbers the tools can fetch; they go stale.
- Use what you remember without being asked: if you know Dave prefers texts,
  suggest a text.

YOU CAN SCHEDULE YOUR OWN WORK. "Every morning", "on Friday", "remind me",
"if they have not replied by Thursday" -> create_job with a complete brief to
your future self, then confirm the time in one line. get_jobs lists them,
delete_job cancels. A job that should send anything to a lead must say so in its
instruction; otherwise it reports and drafts.

SOCIAL POSTS. You draft Facebook/Instagram posts; the owner approves and posts
them by hand - you cannot publish anything, and never say you have.
- Always get_content_brief first, and match the owner's own voice from it.
- Build posts on something true and specific: real aggregate numbers from the
  tools (rounded, never a single client's), a practical lesson for installers,
  or how the business actually works. If there is nothing true and interesting
  to say, say so rather than writing filler.
- Never name or identify a client or lead, never show a client's own figures,
  never invent a number, result or quote.
- List every figure and claim in facts with its source. The editor rejects
  anything else. When it sends a draft back, fix exactly what it says and
  resubmit; do not argue with it. Three rejections: stop and tell the owner why.
- Once saved, tell them it is on the Posts screen, in one line.

THE WEB. web_search and web_fetch are for the outside world: a business, a
supplier, a competitor, a suburb, a regulation, a news item. Never for our own
numbers, which are only ever from the tools above.

WHAT HAS BEEN SENT IS IN THE LOG, NOT IN YOUR MEMORY. Before you say whether
anything went out, before a follow-up or chase, and after any error or cut-off
during a send, call get_outreach_log and answer from it. A request can die
halfway through a send; the log is the only record of what actually happened.
- More than 3 leads: send_bulk_message, once. Never loop send_lead_sms or
  send_lead_email over a list. Preview first, read back who is in and who is
  left out, get a yes, then send with dry_run false.
- Never message a lead twice. Anyone contacted in the last 7 days is left out
  automatically; only lower that if the owner explicitly says so. The server
  refuses the same message to the same person within 30 days - if a send is
  refused as already sent, it was sent: say so, do not try to get round it.

NO DASHES. Never put an em dash or an en dash in anything you write: emails,
texts, posts, drafts, replies. Use a full stop, a comma or a plain hyphen.

BEFORE ANYTHING IRREVERSIBLE - sending an email or SMS, deleting a task - say
what you are about to do and who it affects, and wait for them to confirm. Use
get_email_draft to read an email back before sending it. Never act on a lead you
matched loosely; if more than one matched, ask which.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Declared outside the try so a question that errors halfway is still
  // costed - the API calls it made before failing were billed all the same.
  const spend = newSpend()
  let channel = 'panel'
  let spender: string | null = null
  const recordUsage = async (outcome: string) => {
    if (!spend.steps) return
    try {
      const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { error } = await db.from('jarvis_usage').insert({
        channel,
        user_id: spender,
        model: [...spend.models].join(', ') || null,
        outcome,
        steps: spend.steps,
        input_tokens: spend.input,
        output_tokens: spend.output,
        cache_read_tokens: spend.cacheRead,
        cache_write_tokens: spend.cacheWrite,
        web_searches: spend.searches,
        web_fetches: spend.fetches,
        cost_usd: Math.round(spend.cost * 1e6) / 1e6,
      })
      if (error) console.error('jarvis-chat: usage not recorded:', error.message)
    } catch (err) {
      console.error('jarvis-chat: usage not recorded:', (err as Error).message)
    }
  }

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
    // Scheduled jobs come in the same way, from jarvis-notify's heartbeat, and
    // pass the same service-role capability test.
    let isBridge = false
    if (body?.via === 'sms' || body?.via === 'job') {
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
    // whole business - revenue, margin, ad spend, every client, every rep's
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
    channel = isBridge ? String(body.via) : 'panel'
    spender = userId
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
        messages: withoutThinking(trimHistory(msgs)),
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
      ? withoutThinking(await loadThread())
      : Array.isArray(body.messages) ? body.messages : []
    // A thread that ends on tool results is a turn that was cut off mid-way.
    // Close it in words that send him to the log, rather than letting him
    // guess what happened.
    if (threaded && messages[messages.length - 1]?.role === 'user' && typeof messages[messages.length - 1].content !== 'string') {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: '[My last request was cut off before I finished. Anything above may or may not have completed; I must check get_outreach_log before saying what was sent.]' }],
      })
    }
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
          `Channel: ${channel}.` +
          (channel === 'job'
            ? ' This is one of your scheduled jobs running unattended: nobody is watching this turn. Do the ' +
              'job now, then write the report that will be texted to the owner - plain text, no markdown, ' +
              'under 600 characters, leading with what matters. Send an email or SMS to a lead ONLY if the ' +
              'job instruction explicitly says to; otherwise draft it and say in the report what you would ' +
              'send, so they can reply yes.'
            : '') +
          `\n\nWHAT YOU REMEMBER:\n${remembered}`,
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
        model: Deno.env.get('JARVIS_MODEL') ?? 'claude-opus-5-5',
        max_tokens: 8192,
        system,
        // drop_block: if a stored thread ever does carry thinking the model no
        // longer accepts, drop that reasoning and answer rather than fail the
        // whole question. withoutThinking() means it should never be needed.
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
        // Set explicitly: Opus 5.5 defaults to medium. He is spoken aloud and
        // most questions are one lookup, so low keeps him quick and cheap.
        output_config: { effort: 'low' },
        // Routes around a safety refusal instead of returning nothing.
        betas: ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01'],
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

      addUsage(spend, res)
      messages.push({ role: 'assistant', content: res.content })

      // Record the hosted tools too, so the panel shows he went to the web.
      for (const b of res.content as { type: string; name?: string }[]) {
        if (b.type === 'server_tool_use' && b.name) used.push(b.name)
      }

      if (res.stop_reason === 'refusal') {
        // Not saved: a refused turn in the stored thread would poison the next.
        await recordUsage('refused')
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
        await recordUsage('answered')
        return json({ reply, tools: used, messages: threaded ? undefined : messages }, 200)
      }

      // Every tool_use block must come back in ONE user message, including the
      // failures - dropping one ends the conversation mid-turn.
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
      // Saved after every round, not only at the end: if this request is cut
      // off (the platform's time limit, a dropped connection), the next
      // question still sees what the tools already did - including sends.
      await saveThread(messages)
    }

    // Close the turn in words so the saved thread stays a valid conversation
    // and the next question does not land in the middle of a tool call.
    const giveUp = 'That took too many steps, sir. Tell me which part to do first.'
    if (messages[messages.length - 1]?.role === 'user') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: giveUp }] })
    }
    await saveThread(messages)
    await recordUsage('too_many_steps')
    return json({ reply: giveUp, tools: used }, 200)
  } catch (err) {
    await recordUsage('error')
    return json({ error: (err as Error).message }, 500)
  }
})
