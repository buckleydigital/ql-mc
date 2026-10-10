/**
 * Content: social posts JARVIS drafts for the owner to approve and post.
 *
 * Not connected to any social account. There is no publish tool, on purpose:
 * a post ends on the Posts screen as a branded image and a caption, and the
 * owner posts it themselves.
 *
 * Drafting goes through jarvis-content, which runs every draft past a lint and
 * an editor model before saving it. A draft that fails comes back with the
 * exact fixes; revise and call create_post_draft again. Only passing drafts
 * reach the owner.
 */

import { select, invoke } from './db.mjs'

async function getContentBrief() {
  const out = await invoke('jarvis-content', { action: 'brief' })
  return {
    summary: out.brief_is_default
      ? 'Using the default content brief (the owner has not written one yet).'
      : 'Content brief loaded.',
    ...out,
  }
}

async function createPostDraft({ caption, card, facts = [], platforms, post_id } = {}) {
  const out = await invoke('jarvis-content', {
    action: 'draft', caption, card, facts, platforms, post_id,
  })
  if (out.accepted) {
    return {
      summary: out.needs_work
        ? `Saved on the Posts screen (editor ${out.score}/10, with its notes for the owner). Revise once with post_id if you can act on the fixes; otherwise tell the owner it is there.`
        : `Draft passed the editor (${out.score}/10) and is on the Posts screen for approval.`,
      ...out,
    }
  }
  // Not an error: the editor did its job. Only something untrue or
  // unpublishable comes back - cut or rephrase what it names.
  return {
    summary: `Not saved: ${out.stage === 'lint' ? 'the lint' : 'the editor'} found something untrue or unpublishable${out.score ? ` (${out.score}/10)` : ''}. Cut or rephrase what it names and call create_post_draft again.`,
    ...out,
  }
}

async function getPosts({ status } = {}) {
  const params = {
    select: 'id,created_at,caption,original_caption,card,facts,image_url,editor_score,status,approved_at,posted_at',
    order: 'created_at.desc',
  }
  if (status) params.status = `eq.${status}`
  else params.status = 'neq.rejected'
  const { rows, total } = await select('jarvis_posts', params, { limit: 30 })
  const drafts = rows.filter((r) => r.status === 'draft').length
  return { summary: `${total} post${total === 1 ? '' : 's'}; ${drafts} waiting for approval.`, posts: rows }
}

export const CONTENT_TOOLS = [
  {
    name: 'get_content_brief',
    description:
      'Before writing any social post: the content brief (audience, voice, rules), the owner\'s approved posts and their edits to your drafts (match that voice), and recent posts (do not repeat a topic or hook).',
    inputSchema: { type: 'object', properties: {} },
    handler: getContentBrief,
  },
  {
    name: 'create_post_draft',
    description:
      'Submit a Facebook/Instagram post for the owner to approve. It is checked by a strict editor first; if it fails you get the issues and fixes - revise and resubmit. ' +
      'Nothing is ever published: the owner posts it themselves. ' +
      'Every number and factual claim in the caption or card must be listed in facts with where it came from (a tool you ran, a table, the owner). ' +
      'Card styles: "stat" (stat of 9 characters or fewer, e.g. "3 sec", plus a headline), "tip" (a punchy headline, optional body), "quote" (a real quote the owner has approved, with attribution). ' +
      'Pass post_id to revise an existing draft.',
    inputSchema: {
      type: 'object',
      properties: {
        caption: { type: 'string', description: 'The full post caption, as it will be posted.' },
        card: {
          type: 'object',
          description: 'The image text.',
          properties: {
            style: { type: 'string', enum: ['stat', 'tip', 'quote'] },
            kicker: { type: 'string', description: 'Small label above, 32 characters max. Optional.' },
            stat: { type: 'string', description: 'stat style only: the number, 9 characters max.' },
            headline: { type: 'string', description: '90 characters max. For quote style, the quote itself.' },
            body: { type: 'string', description: 'Optional supporting line, 170 characters max.' },
            attribution: { type: 'string', description: 'quote style only.' },
          },
          required: ['style', 'headline'],
        },
        facts: {
          type: 'array',
          description: 'Every figure or claim the post rests on.',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string', description: 'The fact, with its numbers, e.g. "98% of 400 delivered leads arrived within 5 minutes".' },
              source: { type: 'string', description: 'Where it came from, e.g. "ppl_leads delivered_at vs created_at, Mar-Aug 2026".' },
            },
            required: ['claim', 'source'],
          },
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['facebook', 'instagram', 'linkedin'] },
          description: 'Where it is meant for. Default facebook + instagram.',
        },
        post_id: { type: 'string', description: 'To revise an existing draft.' },
      },
      required: ['caption', 'card', 'facts'],
    },
    handler: createPostDraft,
  },
  {
    name: 'get_posts',
    description: 'Posts you have drafted and their state: draft (waiting for the owner), approved, posted. Includes the owner\'s edits.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['draft', 'approved', 'posted'] } },
    },
    handler: getPosts,
  },
]
