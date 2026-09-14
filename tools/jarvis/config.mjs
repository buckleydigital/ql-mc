/**
 * Configuration for the QuoteLeads MCP server.
 *
 * Everything comes from the environment, because this server is launched by
 * JARVIS's bridge (or any MCP client) rather than by a person — there is no
 * prompt to answer and no file to pick. Start it with `node --env-file=.env`
 * or set the variables in the MCP client's `env` block.
 */

const required = (name) => {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Copy tools/jarvis/.env.example to .env and fill it in.`,
    )
  }
  return value
}

const list = (name, fallback) =>
  (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

export const config = {
  /** PostgREST base, e.g. https://<ref>.supabase.co */
  url: () => required('QL_SUPABASE_URL').replace(/\/+$/, ''),

  /**
   * Service-role or anon key. Service-role reads past RLS, which is what a
   * single-operator assistant wants; it never leaves this machine, and this
   * server exposes no tool that runs caller-supplied SQL.
   */
  key: () => required('QL_SUPABASE_KEY'),

  /**
   * The business runs on Australian dates. "Today" has to mean the local day,
   * not UTC, or every morning before 10am reports yesterday's numbers.
   */
  timezone: process.env.QL_TIMEZONE ?? 'Australia/Sydney',

  /**
   * Stage vocabulary. `leads.stage` is free text, so which values count as won
   * or dead is a business fact, not a schema fact — it belongs in config where
   * it can change without a code edit.
   */
  wonStages: list('QL_WON_STAGES', 'won,closed won,client,signed'),
  deadStages: list('QL_DEAD_STAGES', 'lost,dead,closed lost,disqualified'),

  /** Currency label used in spoken summaries. */
  currency: process.env.QL_CURRENCY ?? 'AUD',
}
