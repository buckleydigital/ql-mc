# Lead webhook

`POST` to the client's configured URL, `Content-Type: application/json`.

## Payload

```json
{
  "event": "lead.delivered",
  "version": "1",
  "delivered_at": "2026-08-09T04:12:33.000Z",
  "lead": {
    "id": "…", "name": "…", "phone": "…", "email": "…",
    "postcode": "…", "suburb": "…", "state": "…", "address": "…",
    "lead_type": "…", "source": "…",
    "is_homeowner": true, "property_type": "…", "roof_type": "…",
    "system_size": "…", "avg_quarterly_bill": "…", "monthly_bill": "…",
    "interested_in": "…", "purchase_timeline": "asap - next 30 days",
    "custom_fields": { "Consent": "…", "Existing System": "6.6kW" }
  }
}
```

Fields are an explicit allowlist. Adding one is a deliberate change to
`buildWebhookPayload`, so a database migration can never alter what clients
receive. Bump `version` if the shape changes incompatibly.

## Authentication

Off by default. When enabled for a client, three headers are added:

| Header | Value |
|---|---|
| `X-QuoteLeads-Timestamp` | Unix seconds |
| `X-QuoteLeads-Signature` | `sha256=` + HMAC-SHA256 of `timestamp + "." + rawBody`, keyed by the secret |
| `X-QuoteLeads-Secret` | the raw secret |

Clients that can compute an HMAC should verify the signature — it also proves
the body was not modified in transit. Clients that cannot (most no-code tools)
can compare `X-QuoteLeads-Secret` instead.

Verify the signature against the **raw request body**, before any JSON parsing
or re-serialisation.

```js
const crypto = require('crypto');
function verify(rawBody, headers, secret) {
  const ts  = headers['x-quoteleads-timestamp'];
  const got = headers['x-quoteleads-signature'];
  const exp = 'sha256=' + crypto.createHmac('sha256', secret)
                                .update(ts + '.' + rawBody).digest('hex');
  if (got.length !== exp.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(exp))) return false;
  return Math.abs(Date.now() / 1000 - Number(ts)) < 300;  // reject replays
}
```

## Behaviour

- 15 second timeout. A non-2xx or a timeout marks the delivery failed and is
  recorded in `lead_delivery_log`; the secret itself is never logged.
- No automatic retry. Re-drive a failed delivery from Mission Control.
- Any 2xx is treated as success; the response body is not inspected.
