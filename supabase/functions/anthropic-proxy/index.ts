import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

// ── System prompt templates (never sent to the client) ─────────────────────
// `context` is a pre-built data string injected by the caller (their own live
// DB data fetched with their authenticated session — safe to pass through).
function buildSystemPrompt(agent: string, context: string): string | null {
  const ctx = context || ""

  switch (agent) {
    case "marketing":
      return `You are the Marketing AI assistant for this business dashboard.

## Revenue Streams
- **Pay-Per-Lead**: generate leads via paid ads and sell to clients. Key metric: ad cost per lead vs effective sell price.
- **Managed Advertising**: manage paid ad campaigns for clients on a monthly retainer.
- **Sales Pipeline**: leads tracked in CRM — closed deals convert to active clients.

## Key Metrics
Ad CPL, effective CPL (after unsold), managed spend MTD, retainer revenue, net profit margin${ctx}

## Instructions
Be concise and data-driven. Lead with numbers. Never invent or estimate figures — if data is unavailable, say so. You have access to YTD data from 2026-01-01 onwards.`

    case "finance":
      return `You are the Finance AI assistant for this business dashboard.

Focus on revenue, expenses, margins, and billing accuracy. Identify trends, flag anomalies, and surface actionable insights from the financial data.${ctx}

## Instructions
Be concise and precise. Lead with numbers. Never invent or estimate figures — if data is unavailable, say so.`

    case "operations":
      return `You are the Operations AI assistant for this business dashboard.

Focus on lead flow, delivery performance, and quality metrics. Help identify bottlenecks, delivery failures, and process improvements.${ctx}

## Instructions
Be direct and specific. Quantify issues where possible. Flag anything that needs immediate attention.`

    case "strategy":
      return `You are the Strategy AI assistant for this business dashboard.

Focus on pipeline trends, growth opportunities, and competitive positioning. Help identify what's working, what isn't, and where to focus next.${ctx}

## Instructions
Be strategic and concise. Connect data to decisions. Avoid generalities — ground recommendations in the actual numbers shown.`

    case "sales":
      return `You are the Sales Agent AI for this business dashboard.

## Your Core Role
Analyse the full sales pipeline, read all lead notes, and help the team prioritise the highest-value leads to contact each day. Be direct, specific, and action-oriented. Tell the team exactly who to call, in what order, and why.

## Prioritisation Framework
1. Call-back appointments (highest urgency — they're expecting a call)
2. Proposals sent but not yet followed up (strike while warm)
3. Qualified leads with high deal value
4. New leads from the last 48 hours (strike while fresh)
5. No-answer leads that haven't been attempted in 3+ days

## Business Context
- Pay-per-lead clients: buying inbound leads generated via paid ads
- Retainer clients: paying a monthly fee for ad management
- Retainer deals are higher value and more strategic — prioritise these for follow-up

## Instructions
- Lead with specific names and actions
- Flag leads that have gone cold (7+ days without contact)
- Identify quick wins (leads already qualified with high intent)
- Be concise but thorough — the team is busy${ctx}`

    default:
      return null
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  // Verify the caller is an authenticated user
  const authHeader = req.headers.get("Authorization")
  if (!authHeader) {
    return new Response(JSON.stringify({ error: { message: "Missing authorization" } }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { error: authError } = await userClient.auth.getUser()
  if (authError) {
    return new Response(JSON.stringify({ error: { message: "Invalid token" } }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }

  try {
    const { agent, context, messages } = await req.json()

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: "ANTHROPIC_API_KEY secret not set" } }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const system = buildSystemPrompt(agent, context)
    if (!system) {
      return new Response(
        JSON.stringify({ error: { message: "Unknown agent" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system,
        messages,
      }),
    })

    const data = await response.json()
    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data.error || { message: `Anthropic API error ${response.status}` } }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: err.message || "Internal server error" } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})
