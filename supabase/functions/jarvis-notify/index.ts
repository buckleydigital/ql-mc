/**
 * jarvis-notify - the heartbeat.
 *
 * Runs on a schedule, asks the watchers what is wrong, and leaves one note in
 * the Jarvis panel about anything new. This is what turns Jarvis from
 * something you open into something that speaks first.
 *
 * It used to text the owner. Since 7 Oct it does not (migration
 * 20261007000004): the same message is written to jarvis_notifications with
 * channel 'panel' and shown, unread, in the dashboard. No Twilio, so no SMS
 * credits, and no quiet hours or daily cap - an unread note waits quietly.
 *
 * Composition is deliberately deterministic rather than a Claude call. These
 * are factual alerts about money and clients; a model paraphrasing "3 overdue"
 * is a downside with no matching upside, and it would put a paid API call and a
 * network failure in the path of every heartbeat. Jarvis's voice lives in the
 * templates. Phrasing can move to a model later without touching detection.
 *
 * It never calls a model. It used to run Jarvis's scheduled jobs through
 * jarvis-chat; those were removed on 9 Oct so Jarvis only spends API credit
 * when someone asks him something.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

type Ev = {
  id: string
  kind: string
  tier: string
  subject: string | null
  payload: Record<string, unknown>
}

// Jarvis's voice. One line per event, shortest thing that still tells you what
// to do, so a note reads at a glance.
function describe(e: Ev): string {
  const who = e.subject || 'Unnamed'
  switch (e.kind) {
    case 'won_no_account': {
      const h = Number(e.payload.hours ?? 0)
      const d = h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`
      return `${who} closed won ${d} ago and still has no HQ account.`
    }
    case 'proposal_cold': {
      const d = Number(e.payload.days ?? 0)
      const v = e.payload.value
      // The value is worth saying when it is there, because it is what decides
      // which of these you ring back first. Most leads carry none, so it is
      // appended rather than assumed.
      const worth = typeof v === 'number' && v > 0 ? ` ($${v.toLocaleString('en-AU')})` : ''
      return `${who}${worth} - proposal cold ${d} days.`
    }
    case 'don_off': {
      const n = Number(e.payload.waiting ?? 0)
      const h = Number(e.payload.since_hours ?? 0)
      // Naming the config case explicitly: "turn it on" is the wrong
      // instruction when the switch that matters is a different one.
      const why = e.payload.config_inactive ? ' Its agent is set inactive.' : ''
      return `The AI SMS agent is off and ${n} ${n === 1 ? 'lead has' : 'leads have'} texted in` +
        `${h ? `, oldest ${h}h ago` : ''}.${why}`
    }
    case 'followup_overdue':
      return `${who} - follow-up is overdue.`
    case 'fulfilment_overdue':
      return `${who} - onboarding is past due${e.payload.step ? ` on ${e.payload.step}` : ''}.`
    case 'fulfilment_blocked':
      return `${who} - fulfilment is blocked${e.payload.blocked ? ` (${e.payload.blocked})` : ''}.`
    default:
      return `${who} - ${e.kind}.`
  }
}

// Refresh the mirror of Don's on/off state.
//
// Don's config lives in ql-hq. A watcher is a SELECT, and a SELECT cannot make
// an HTTP call to another project - so the only way jarvis_scan() can see him
// is if his state is sitting in a local column when it runs. Same arrangement
// as fulfilment, which ql-hq pushes here for the same reason.
//
// Best effort on purpose. If ql-hq is unreachable the columns keep their last
// values and don_synced_at goes stale, which the watcher reads as "I do not
// know" and stays quiet about, rather than announcing an outage as though Don
// had been switched off.
// deno-lint-ignore no-explicit-any
async function syncDonState(db: any): Promise<void> {
  const hq = Deno.env.get('QL_HQ_API_URL')
  const secret = Deno.env.get('QL_MC_API_SECRET')
  if (!hq || !secret) return

  try {
    const res = await fetch(`${hq}/sync-from-mc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': secret },
      body: JSON.stringify({ action: 'get_sms_agent_config' }),
    })
    if (!res.ok) {
      console.warn('syncDonState: ql-hq returned', res.status)
      return
    }
    const cfg = (await res.json())?.config
    if (!cfg) return

    // Both halves matter. auto_reply off means he is not answering; is_active
    // off means the config is not even attached to the inbound number, so
    // switching auto_reply on alone would not wake him. Recording only the
    // first would make "Don is on" true and useless.
    const { data: row } = await db.from('business_settings').select('id').limit(1).maybeSingle()
    if (!row?.id) return
    await db.from('business_settings').update({
      don_enabled:   cfg.auto_reply === true,
      don_active:    cfg.is_active === true,
      don_synced_at: new Date().toISOString(),
    }).eq('id', row.id)
  } catch (err) {
    console.warn('syncDonState failed:', err instanceof Error ? err.message : err)
  }
}

Deno.serve(async (req: Request) => {
  // No public surface. The only callers are pg_cron (via pg_net) and a human
  // testing with the same key. Checked here rather than by verify_jwt, because
  // a cron has no user JWT to present.
  //
  // The check is a capability test, not a string compare. Comparing the bearer
  // to SUPABASE_SERVICE_ROLE_KEY looked equivalent and was not: the value the
  // edge runtime injects is not always the same string as the service_role key
  // in the dashboard, so the first live cron returned 401 - and would have gone
  // on doing that silently every 15 minutes, which is the worst possible
  // failure for something whose whole job is telling you when things are wrong.
  //
  // Instead the presented key is used to read jarvis_events, which is revoked
  // from anon and authenticated and forces RLS with no policies. Only a
  // service-role key can read it, so a successful read IS the proof of
  // authority, and it cannot drift out of sync with a rotated or reformatted
  // key the way a hardcoded comparison does.
  const auth = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
  if (!auth) return json({ error: 'unauthorized' }, 401)

  const url = Deno.env.get('SUPABASE_URL')!
  const caller = createClient(url, auth)
  const { error: authErr } = await caller.from('jarvis_events').select('id').limit(1)
  if (authErr) return json({ error: 'unauthorized' }, 401)

  // Past the gate, use the runtime's own key for the work itself.
  const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const body = await req.json().catch(() => ({}))
    // dry_run reports what it WOULD leave in the panel, and writes nothing.
    const dryRun = body?.dry_run === true

    const { data: s } = await db
      .from('business_settings').select('jarvis_timezone').limit(1).maybeSingle()
    const tz = s?.jarvis_timezone || 'Australia/Sydney'

    // The mirror first, then the scan: jarvis_scan() reads don_enabled, so
    // refreshing it afterwards would leave every run reasoning about the
    // previous heartbeat's answer.
    await syncDonState(db)

    const { data: pendingCount, error: scanErr } = await db.rpc('jarvis_apply_scan')
    if (scanErr) return json({ error: `scan failed: ${scanErr.message}` }, 500)

    const note = (tier: string, text: string, eventIds: string[] = []) =>
      db.from('jarvis_notifications').insert({
        channel: 'panel', to_number: 'panel', tier, body: text, event_ids: eventIds, status: 'sent',
      })

    const { data: events } = await db
      .from('jarvis_events')
      .select('id, kind, tier, subject, payload')
      .is('notified_at', null).is('resolved_at', null)
      .or(`snoozed_until.is.null,snoozed_until.lt.${new Date().toISOString()}`)
      .order('tier', { ascending: true })
      .order('first_seen_at', { ascending: true })
      .limit(20)

    const evs = (events || []) as Ev[]
    if (!evs.length) return json({ ok: true, scanned: pendingCount, noted: false, reason: 'nothing_new' })

    // One note per run, never one per event - a briefing, not six pings.
    // Urgent ones first; the panel has room for all of them.
    const urgent = evs.filter((e) => e.tier === 'urgent')
    const rest = evs.filter((e) => e.tier !== 'urgent')
    const text = [...urgent, ...rest].map(describe).join('\n')
    const tier = urgent.length ? 'urgent' : 'notable'

    if (dryRun) {
      return json({ ok: true, scanned: pendingCount, noted: false, reason: 'dry_run', would_note: text, events: evs.length })
    }

    const { error: noteErr } = await note(tier, text, evs.map((e) => e.id))
    // Only mark them told if the note was saved. A failed write that silently
    // burns the events is how you find out about a problem never.
    if (!noteErr) {
      await db.from('jarvis_events')
        .update({ notified_at: new Date().toISOString() })
        .in('id', evs.map((e) => e.id))
    }

    return json({
      ok: !noteErr, scanned: pendingCount, noted: !noteErr, events: evs.length,
      ...(noteErr ? { error: noteErr.message } : {}),
    })
  } catch (err) {
    console.error('jarvis-notify error:', err)
    return json({ error: err instanceof Error ? err.message : 'Internal server error' }, 500)
  }
})
