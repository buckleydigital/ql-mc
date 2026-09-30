/**
 * Jobs: work JARVIS schedules for himself.
 *
 * "Every weekday at 8 text me the numbers." "Thursday, chase Sandford if they
 * have not replied." Before this he could only act while someone was talking to
 * him. A job is an instruction plus a time; the heartbeat (jarvis-notify, every
 * 15 minutes) claims the due ones, runs each through jarvis-chat with his full
 * tools and memory, and texts the result to the owner.
 *
 * Times are LOCAL (config.timezone). The owner says "8am", not "22:00 UTC".
 */

import { select, insert, patch } from './db.mjs'
import { config } from './config.mjs'
import { localDate, offsetMinutes } from './dates.mjs'

const REPEATS = ['once', 'daily', 'weekdays', 'weekly', 'monthly']

/** Cost guard: every active job is a model run on its schedule. */
const MAX_ACTIVE_JOBS = 25

/** A local wall-clock time as a UTC instant, correct across DST (two passes). */
function localInstant(date, time) {
  const guess = new Date(`${date}T${time}:00Z`)
  const first = new Date(guess.getTime() - offsetMinutes(guess) * 60000)
  return new Date(guess.getTime() - offsetMinutes(first) * 60000)
}

const localWhen = (iso) =>
  iso
    ? new Intl.DateTimeFormat('en-AU', {
        timeZone: config.timezone, weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit',
      }).format(new Date(iso))
    : null

async function getJobs() {
  const { rows } = await select(
    'jarvis_jobs',
    { select: 'id,title,instruction,repeat,next_run_at,last_run_at,last_result,runs', active: 'is.true', order: 'next_run_at.asc' },
    { limit: 100 },
  )
  const jobs = rows.map((j) => ({ ...j, next_run_local: localWhen(j.next_run_at) }))
  return {
    summary: jobs.length
      ? `${jobs.length} scheduled: ${jobs.slice(0, 3).map((j) => `${j.title} (${j.next_run_local})`).join('; ')}.`
      : 'Nothing scheduled.',
    jobs,
  }
}

async function createJob({ title, instruction, date, time, repeat = 'once' } = {}) {
  title = String(title ?? '').trim()
  instruction = String(instruction ?? '').trim()
  if (!title || !instruction) throw new Error('title and instruction are required')
  if (!REPEATS.includes(repeat)) throw new Error(`repeat must be one of ${REPEATS.join(', ')}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) throw new Error('date must be YYYY-MM-DD (local)')
  if (!/^\d{2}:\d{2}$/.test(String(time ?? ''))) throw new Error('time must be HH:MM, 24-hour, local')

  const at = localInstant(date, time)
  if (Number.isNaN(at.getTime())) throw new Error('That date and time do not exist.')
  if (at.getTime() < Date.now() - 60_000) {
    throw new Error(`${date} ${time} has already passed (today is ${localDate()}). Pick a future time.`)
  }

  const { total } = await select('jarvis_jobs', { select: 'id', active: 'is.true' }, { limit: 1 })
  if (total >= MAX_ACTIVE_JOBS) {
    throw new Error(`There are already ${total} scheduled jobs, the limit. Cancel one first.`)
  }

  const [row] = await insert('jarvis_jobs', {
    title: title.slice(0, 120),
    instruction: instruction.slice(0, 2000),
    repeat,
    next_run_at: at.toISOString(),
  })
  return {
    summary: `Scheduled "${row.title}" for ${localWhen(row.next_run_at)}${repeat === 'once' ? '' : `, then ${repeat}`}.`,
    job: { id: row.id, title: row.title, repeat: row.repeat, next_run_local: localWhen(row.next_run_at) },
  }
}

async function deleteJob({ job_id } = {}) {
  if (!job_id) throw new Error('job_id is required - get it from get_jobs.')
  // Deactivated rather than deleted, so its history stays readable.
  const rows = await patch('jarvis_jobs', { id: `eq.${job_id}` }, { active: false })
  if (!rows.length) return { summary: 'No job with that id.' }
  return { summary: `Cancelled "${rows[0].title}".` }
}

export const JOB_TOOLS = [
  {
    name: 'get_jobs',
    description: 'List the jobs you have scheduled for yourself: what, when next, how often, and the last result. Returns the ids delete_job needs.',
    inputSchema: { type: 'object', properties: {} },
    handler: getJobs,
  },
  {
    name: 'create_job',
    description:
      'Schedule work for yourself to do later, once or on repeat - a report, a check, a follow-up. ' +
      'When it comes due you will run it with all your tools and memory, and the result is texted to the owner. ' +
      'Write the instruction as a complete brief to your future self: what to check or do, for whom, and what ' +
      'to report. If it may send an email or SMS to a lead, say so explicitly in the instruction - a job only ' +
      'sends to leads when its instruction says to. Times are local.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name, e.g. "Morning numbers".' },
        instruction: { type: 'string', description: 'The full brief for when it runs.' },
        date: { type: 'string', description: 'First run date, YYYY-MM-DD, local.' },
        time: { type: 'string', description: 'First run time, HH:MM 24-hour, local.' },
        repeat: { type: 'string', enum: REPEATS, description: 'once (default), daily, weekdays, weekly or monthly.' },
      },
      required: ['title', 'instruction', 'date', 'time'],
    },
    handler: createJob,
  },
  {
    name: 'delete_job',
    description: 'Cancel a scheduled job. Takes the id from get_jobs.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job UUID, from get_jobs.' } },
      required: ['job_id'],
    },
    handler: deleteJob,
  },
]
