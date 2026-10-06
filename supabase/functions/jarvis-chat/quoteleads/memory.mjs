/**
 * Long-term memory: what JARVIS has been told and should still know tomorrow.
 *
 * Before this, "memory" was the transcript the browser happened to be holding.
 * Reload the page and it was gone; a text message and the panel had never met.
 * These are durable facts - preferences, standing instructions, context about a
 * client - kept in jarvis_memory and handed to the model at the start of every
 * conversation, on every channel.
 *
 * Business numbers are NOT memory. They come from the tools every time, because
 * a remembered figure is a stale figure. Memory is for what the database does
 * not already say: "Dave at Sandford prefers texts", "never chase before 9am",
 * "the goal this quarter is 60 closes".
 *
 * Naming follows the bridge's verb rules (see tools.mjs): get_ reads,
 * create_/delete_ write. The hosted brain lets the memory tools through even in
 * read-only mode - writing a note to himself reaches no customer.
 */

import { select, insert, remove } from './db.mjs'

/** How much memory goes into the prompt. Newest first past this. */
const MEMORY_LIMIT = 200

export async function loadMemories() {
  const { rows } = await select(
    'jarvis_memory',
    { select: 'id,content,created_at', order: 'created_at.desc' },
    { limit: MEMORY_LIMIT },
  )
  return rows.reverse()
}

async function getMemories({ search } = {}) {
  const params = { select: 'id,content,source,created_at', order: 'created_at.desc' }
  if (search) params.content = `ilike.*${String(search).replace(/[*,()]/g, ' ').trim()}*`
  const { rows, total } = await select('jarvis_memory', params, { limit: MEMORY_LIMIT })
  return { summary: `${total} memor${total === 1 ? 'y' : 'ies'}.`, memories: rows }
}

async function createMemory({ content, source } = {}) {
  const text = String(content ?? '').trim()
  if (!text) throw new Error('Nothing to remember.')
  if (text.length > 1000) throw new Error('Keep a memory under 1000 characters - one fact per memory.')
  const [row] = await insert('jarvis_memory', { content: text, source: source || null })
  return { summary: 'Remembered.', memory: { id: row.id, content: row.content } }
}

async function deleteMemory({ memory_id } = {}) {
  if (!memory_id) throw new Error('memory_id is required - get it from get_memories.')
  const rows = await remove('jarvis_memory', { id: `eq.${memory_id}` })
  if (!rows.length) return { summary: 'No memory with that id.' }
  return { summary: 'Forgotten.', memory: { id: rows[0].id, content: rows[0].content } }
}

export const MEMORY_TOOLS = [
  {
    name: 'get_memories',
    description:
      'List what you have been told to remember. The hosted assistant already has these in its instructions; use this to find a memory id before deleting or correcting one, or to search by keyword.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Optional keyword to filter by.' } },
    },
    handler: getMemories,
  },
  {
    name: 'create_memory',
    description:
      'Save a durable fact for future conversations: a preference, a standing instruction, context about a client, lead or rep, a goal, a decision. One fact per call, written so it makes sense with no other context ("Dave at Sandford Electrical prefers SMS over email"). Never store business numbers the tools can fetch - they go stale.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact, as a complete sentence.' },
        source: { type: 'string', description: 'Optional: panel or sms.' },
      },
      required: ['content'],
    },
    handler: createMemory,
  },
  {
    name: 'delete_memory',
    description:
      'Forget a memory that is wrong or no longer true. Takes the id from get_memories. To correct one, delete it and create the corrected version.',
    inputSchema: {
      type: 'object',
      properties: { memory_id: { type: 'string', description: 'Memory UUID, from get_memories.' } },
      required: ['memory_id'],
    },
    handler: deleteMemory,
  },
]
