/**
 * Configuration for the QuoteLeads MCP server.
 *
 * Everything comes from the environment, because this server is launched by
 * JARVIS's bridge (or any MCP client) rather than by a person — there is no
 * prompt to answer and no file to pick. Start it with `node --env-file=.env`
 * or set the variables in the MCP client's `env` block.
 */

/**
 * Read an environment variable in either runtime.
 *
 * These modules run in two places: Node, as the MCP server the local bridge
 * spawns, and Deno, inside the jarvis-chat edge function. Reading env through
 * one accessor is what lets the tool implementations stay a single copy.
 */
export const env = (name) =>
  globalThis.Deno?.env?.get?.(name) ?? globalThis.process?.env?.[name] ?? undefined

const required = (name) => {
  const value = env(name)
  if (!value) {
    throw new Error(
      `${name} is not set. Copy tools/jarvis/.env.example to .env and fill it in.`,
    )
  }
  return value
}

/**
 * Stage names are matched on a canonical form: lowercased, with underscores
 * and hyphens folded to spaces. The database says `closed_won`; someone
 * configuring this will write `closed won` or `Closed Won`. All three match,
 * because a silent miss here reports zero closes rather than an error.
 */
export const stageKey = (s) =>
  String(s ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')

const list = (name, fallback) =>
  (env(name) ?? fallback)
    .split(',')
    .map(stageKey)
    .filter(Boolean)

export const config = {
  /** PostgREST base, e.g. https://<ref>.supabase.co */
  // Inside an edge function SUPABASE_URL and the service-role key are provided
  // by the platform, so the QL_ names are only needed outside it.
  url: () => (env('QL_SUPABASE_URL') ?? required('SUPABASE_URL')).replace(/\/+$/, ''),

  /**
   * Service-role or anon key. Service-role reads past RLS, which is what a
   * single-operator assistant wants; it never leaves this machine, and this
   * server exposes no tool that runs caller-supplied SQL.
   */
  key: () => env('QL_SUPABASE_KEY') ?? required('SUPABASE_SERVICE_ROLE_KEY'),

  /**
   * The business runs on Australian dates. "Today" has to mean the local day,
   * not UTC, or every morning before 10am reports yesterday's numbers.
   */
  timezone: env('QL_TIMEZONE') ?? 'Australia/Sydney',

  /**
   * Stage vocabulary. `leads.stage` is free text, so which values count as won
   * or dead is a business fact, not a schema fact — it belongs in config where
   * it can change without a code edit.
   */
  // The live vocabulary: closed_won, closed_lost, proposal, no_answer,
  // new_lead. Anything not named here counts as open.
  wonStages: list('QL_WON_STAGES', 'closed_won,won'),
  deadStages: list('QL_DEAD_STAGES', 'closed_lost,lost,dead,disqualified'),

  /**
   * A lead with no owner_id is not unassigned — it is handled by the operator
   * running this assistant. Naming that makes the rep table complete instead
   * of showing most of the pipeline as nobody's.
   */
  ownerlessName: env('QL_OWNERLESS_NAME') ?? 'you',

  /** Currency label used in spoken summaries. */
  currency: env('QL_CURRENCY') ?? 'AUD',
}
