#!/usr/bin/env node
/**
 * QuoteLeads MCP server — the QuoteLeads data, as tools an assistant can call.
 *
 * Speaks MCP over stdio: newline-delimited JSON-RPC on stdin/stdout. The
 * protocol is implemented here rather than pulled from the SDK so the server
 * has no dependencies at all — `node server.mjs` runs on any machine with Node
 * 20, with no install step and no lockfile to drift.
 *
 * NOTHING may be written to stdout except protocol frames. Diagnostics go to
 * stderr; a stray console.log corrupts the stream and the client disconnects.
 */

import { createInterface } from 'node:readline'
import { TOOLS } from './tools.mjs'

const PROTOCOL_VERSION = '2024-11-05'
const byName = new Map(TOOLS.map((t) => [t.name, t]))

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

async function handle({ id, method, params }) {
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'quoteleads', version: '1.0.0' },
      })

    case 'ping':
      return reply(id, {})

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      })

    case 'tools/call': {
      const tool = byName.get(params?.name)
      if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`)

      try {
        const result = await tool.handler(params.arguments ?? {})
        // The summary leads, because the caller is usually about to read this
        // out loud; the JSON behind it is there when a follow-up needs detail.
        const text = `${result.summary}\n\n${JSON.stringify(result, null, 2)}`
        return reply(id, { content: [{ type: 'text', text }] })
      } catch (err) {
        // An error is a tool result, not a protocol failure: the assistant
        // should be able to say what went wrong rather than go silent.
        return reply(id, {
          content: [{ type: 'text', text: `${tool.name} failed: ${err.message}` }],
          isError: true,
        })
      }
    }

    default:
      // Notifications carry no id and expect no response.
      if (id === undefined || id === null) return
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return fail(null, -32700, 'Parse error')
  }

  try {
    await handle(msg)
  } catch (err) {
    process.stderr.write(`[quoteleads] ${err.stack}\n`)
    if (msg.id != null) fail(msg.id, -32603, err.message)
  }
})

process.stderr.write(`[quoteleads] ready · ${TOOLS.length} tools\n`)
