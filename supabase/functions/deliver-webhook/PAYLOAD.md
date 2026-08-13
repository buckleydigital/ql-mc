# Lead webhook

`POST` to the client's configured URL, `Content-Type: application/json`.

## Payload

```json
{
  "event": "lead.delivered",
  "version": "1",
  "delivered_at": "2026-08-09T04:12:33.000Z",
  "lead": {
    "id": "…", "name": "Sarah Mitchell",
    "first_name": "Sarah", "last_name": "Mitchell",
    "phone": "…", "email": "…",
    "postcode": "…", "suburb": "…", "state": "…", "address": "…",
    "lead_type": "…", "source": "…",
    "is_homeowner": true, "property_type": "…", "roof_type": "…",
    "system_size": "…", "avg_quarterly_bill": "…", "monthly_bill": "…",
    "interested_in": "…", "purchase_timeline": "asap - next 30 days",
    "custom_fields": { "Consent": "…", "Existing System": "6.6kW" }
  }
}
```

`name` is the combined form; `first_name` and `last_name` are split from it for
CRMs that store them separately and often require a surname. A single-word name
becomes the surname, since that is the field CRMs tend to make mandatory.

Fields are an explicit allowlist. Adding one is a deliberate change to
`buildWebhookPayload`, so a database migration can never alter what clients
receive. Bump `version` if the shape changes incompatibly.

## Authentication

Set per client in Mission Control. Three modes.

**`none`** - no auth headers. Fine for Zapier/Make catch hooks and open endpoints.

**`header`** - the credential the client's CRM issued us, sent verbatim under a
header name they specify. This is the usual case, since most CRMs authenticate
the caller.

```
Authorization: Bearer <their token>
X-API-Key: <their key>
```

The header name is restricted to letters, numbers and hyphens; anything else is
dropped rather than sent, so a value can never break the request framing.

**`signature`** - for clients who want to verify the request came from us:

| Header | Value |
|---|---|
| `X-QuoteLeads-Timestamp` | Unix seconds |
| `X-QuoteLeads-Signature` | `sha256=` + HMAC-SHA256 of `timestamp + "." + rawBody`, keyed by the secret |
| `X-QuoteLeads-Secret` | the raw secret |

Verify against the **raw request body**, before any JSON parsing or
re-serialisation.

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

Whichever mode is used, the credential itself is never written to
`lead_delivery_log` - only which mode was applied.

## Behaviour

- 15 second timeout. A non-2xx or a timeout marks the delivery failed and is
  recorded in `lead_delivery_log`; the secret itself is never logged.
- No automatic retry. Re-drive a failed delivery from Mission Control.
- Any 2xx is treated as success; the response body is not inspected.
