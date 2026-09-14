/**
 * A user session for the edge functions.
 *
 * `send-sales-email` and `send-sms` both verify the caller with
 * `auth.getUser(token)` and then attribute the send to that user — the rep's
 * name and reply-to address come out of the session. A service-role key is not
 * a user token and fails that check, so the sending tools need a real login.
 *
 * Reads never come through here: they use the service-role key directly.
 */

import { config } from './config.mjs'

let cached = null

export function hasSendIdentity() {
  return Boolean(process.env.QL_USER_EMAIL && process.env.QL_USER_PASSWORD)
}

/** A valid access token, logging in or refreshing as needed. */
export async function userToken() {
  if (!hasSendIdentity()) {
    throw new Error(
      'Sending requires a login: set QL_USER_EMAIL and QL_USER_PASSWORD. ' +
        'The email and SMS functions attribute the send to that user.',
    )
  }

  // A minute of margin, so a token never expires mid-call.
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token

  const key = process.env.QL_SUPABASE_ANON_KEY || config.key()
  const res = await fetch(`${config.url()}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.QL_USER_EMAIL,
      password: process.env.QL_USER_PASSWORD,
    }),
  })

  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  }

  const session = await res.json()
  cached = {
    token: session.access_token,
    expiresAt: Date.now() + (session.expires_in ?? 3600) * 1000,
  }
  return cached.token
}
