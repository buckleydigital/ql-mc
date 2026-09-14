/**
 * Local-day arithmetic.
 *
 * Every timestamp in the database is timestamptz (UTC), but "how many leads
 * today" means the local business day. In Australia that is 10-11 hours ahead
 * of UTC, so a naive UTC day boundary reports yesterday's number for the whole
 * working morning — the one bug guaranteed to make the assistant untrusted.
 */

import { config } from './config.mjs'

const tz = () => config.timezone

/** Local calendar date as YYYY-MM-DD. */
export function localDate(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/** Local month as YYYY-MM. */
export const localMonth = (at = new Date()) => localDate(at).slice(0, 7)

/** Minutes the zone is ahead of UTC at a given instant. */
function offsetMinutes(at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz(),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(at)
    .reduce((acc, p) => (p.type === 'literal' ? acc : { ...acc, [p.type]: p.value }), {})

  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  )
  return (asUTC - at.getTime()) / 60000
}

/**
 * The UTC instant at which a local date begins, as an ISO string.
 *
 * Two passes: guess with the offset in effect at UTC midnight, then correct
 * with the offset actually in effect at the guess. That second pass is what
 * makes the DST changeover days right.
 */
export function startOfLocalDay(dateStr) {
  const guess = new Date(`${dateStr}T00:00:00Z`)
  const first = new Date(guess.getTime() - offsetMinutes(guess) * 60000)
  const corrected = new Date(guess.getTime() - offsetMinutes(first) * 60000)
  return corrected.toISOString()
}

/** Start of the local day `n` days before `from` (n=0 is today). */
export function daysAgo(n, from = new Date()) {
  const base = new Date(`${localDate(from)}T12:00:00Z`)
  base.setUTCDate(base.getUTCDate() - n)
  return startOfLocalDay(localDate(base))
}

/** Start of the current local month. */
export const startOfMonth = (at = new Date()) =>
  startOfLocalDay(`${localMonth(at)}-01`)
