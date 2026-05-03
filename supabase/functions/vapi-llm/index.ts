// vapi-llm: OpenAI-compatible chat completions proxy to Anthropic.
// VAPI calls this as a "custom-llm" model provider, so no OpenAI (or any other)
// API key needs to be configured in the VAPI dashboard.
// The only secret required is ANTHROPIC_API_KEY set as a Supabase edge function secret.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-vapi-secret, content-type",
}

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || ""
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514"

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: { message: "ANTHROPIC_API_KEY secret not set" } }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }

  try {
    const body = await req.json()
    const { messages = [], stream = false, max_tokens = 1024 } = body

    // VAPI passes the system prompt as a role:"system" message in the messages array.
    // Anthropic requires the system prompt to be a separate top-level field.
    const systemParts = messages.filter((m: any) => m.role === "system")
    const chatMsgs   = messages.filter((m: any) => m.role !== "system")
    const system     = systemParts.map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    ).join("\n\n") || undefined

    const anthropicBody: Record<string, unknown> = {
      model: ANTHROPIC_MODEL,
      max_tokens,
      messages: chatMsgs,
      stream,
    }
    if (system) anthropicBody.system = system

    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(anthropicBody),
    })

    // ── Non-streaming ────────────────────────────────────────────────────────
    if (!stream) {
      const data = await anthropicResp.json()
      if (!anthropicResp.ok) {
        return new Response(JSON.stringify({ error: data.error || "Anthropic error" }), {
          status: anthropicResp.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }
      const text = data.content?.[0]?.text || ""
      const openAIResp = {
        id: data.id || "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: ANTHROPIC_MODEL,
        choices: [{
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: data.stop_reason === "end_turn" ? "stop" : (data.stop_reason || "stop"),
        }],
        usage: {
          prompt_tokens:     data.usage?.input_tokens  || 0,
          completion_tokens: data.usage?.output_tokens || 0,
          total_tokens:      (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
        },
      }
      return new Response(JSON.stringify(openAIResp), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    // ── Streaming: translate Anthropic SSE → OpenAI SSE ─────────────────────
    // VAPI expects the OpenAI streaming format for low-latency voice responses.
    const { readable, writable } = new TransformStream()
    const writer  = writable.getWriter()
    const encoder = new TextEncoder()

    ;(async () => {
      try {
        const reader  = anthropicResp.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        const msgId = "chatcmpl-" + Date.now()
        const created = Math.floor(Date.now() / 1000)

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const raw = line.slice(6).trim()
            if (!raw) continue
            try {
              const evt = JSON.parse(raw)
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                const chunk = {
                  id: msgId,
                  object: "chat.completion.chunk",
                  created,
                  model: ANTHROPIC_MODEL,
                  choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }],
                }
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
              } else if (evt.type === "message_stop") {
                const final = {
                  id: msgId,
                  object: "chat.completion.chunk",
                  created,
                  model: ANTHROPIC_MODEL,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                }
                await writer.write(encoder.encode(`data: ${JSON.stringify(final)}\n\n`))
                await writer.write(encoder.encode("data: [DONE]\n\n"))
              }
            } catch (_) { /* ignore malformed SSE lines */ }
          }
        }
      } catch (e) {
        console.error("vapi-llm streaming error:", e)
      } finally {
        writer.close()
      }
    })()

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error"
    return new Response(JSON.stringify({ error: { message } }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
