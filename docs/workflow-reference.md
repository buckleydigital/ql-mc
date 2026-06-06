# QuoteLeads — PPL Lead Distribution Workflow

## 1. Lead Entry Point

A lead enters via `POST /functions/v1/submit-lead` — typically called by a survey page (e.g. `test-survey.html`) with headers:

```
Authorization: Bearer <anon key>
apikey: <anon key>
Content-Type: application/json
```

Required body fields:

| Field | Notes |
|---|---|
| `name` (or `first_name` + `last_name`) | Required |
| `email` | Required |
| `phone` | Australian number, various formats accepted |
| `postcode` | 4-digit AU postcode |
| `lead_type` or `niche` | e.g. `solar` |
| `source` | e.g. `solar-survey`; defaults to `webhook` |

Named fields that are also recognised (not stored in `custom_fields`):

| Field | Notes |
|---|---|
| `is_homeowner` | Boolean |
| `avg_quarterly_bill` | Numeric |
| `interested_in` | String |
| `purchase_timeline` | String |

Any extra fields not in the named-field whitelist are serialised into `custom_fields` JSON automatically.

---

## 2. Validation

| Field | Rule |
|---|---|
| `name` | Must be non-empty |
| `phone` | Normalised to E.164 (`+61XXXXXXXXX`); accepts AU mobiles and landlines (+61[2–9]xxxxxxxxx); rejected if invalid |
| `postcode` | Must be exactly 4 digits |
| `email` | Must be non-empty and pass basic format check |
| `lead_type` / `niche` | Required; returns `400 missing_lead_type` if absent |

---

## 3. Deduplication

Checks `ppl_leads` for any existing record in the **last 7 days** matching the same **phone OR email**, **within the same `lead_type` only** (so the same contact can submit a solar lead and an aircon lead separately).

If a duplicate is found, returns:

```json
{ "status": "duplicate", "lead_id": "<existing id>" }
```

No new record is created.

---

## 4. Postcode Enrichment

> **Note:** Suburb/state enrichment is not currently functional. The `suburb` and `state` fields on all leads remain `null`. The `postcode-lookup` function is a separate utility used only by survey pages for the coverage chip (see below).

The `postcode-lookup` function powers the **coverage chip** on survey pages (green/amber/grey). It accepts:

```
GET /functions/v1/postcode-lookup?postcode=<4 digits>&niche=<lead_type>
```

It queries active PPL clients filtered by niche and checks if the postcode is in their list with remaining capacity. Returns `{ buyer_name, buyer_id }` on a match, or `{ buyer_name: null }` if no coverage.

---

## 5. Client Matching

Queries the `clients` table where:
- `type = 'ppl'`
- `stage = 'active_client'`
- `niche = <lead_type>` OR `active_niches @> {<lead_type>}`

Then filters in three stages:

### 5a. Postcode Filter

Clients must have a `postcodes` array that **explicitly contains** the lead's postcode. Clients with an empty or null `postcodes` array are **excluded** — there is no open-territory mode.

### 5b. Cap Checks (per candidate)

For each postcode-matching candidate, live counts are pulled from `ppl_leads` where `created_at` falls within the current period:

- **Total order** — skips client if `leads_delivered >= total_leads_purchased`
- **Weekly cap** — counts `status = 'delivered'` since last Monday UTC; skips if `weekly_delivered >= weekly_cap`
- **Monthly cap** — counts `status = 'delivered'` since 1st of month UTC; skips if `monthly_delivered >= monthly_cap`

### 5c. Ranking

Valid candidates are sorted:
1. Clients with an explicit postcode match rank first
2. Lowest fill ratio (`leads_delivered / total_leads_purchased`) to distribute evenly

The top-ranked candidate is the matched client.

---

## 6. Lead Insert

A row is written to `ppl_leads` with all validated/normalised fields plus:

| Field | Value |
|---|---|
| `suburb`, `state` | Always `null` (enrichment not active) |
| `assigned_client_id` | Matched client UUID, or `null` |
| `status` | `'assigned'` if matched, `'pending'` if not |
| `assigned_at` | Timestamp if matched |
| `delivery_method` | Copied from the client record if matched |

Response returned immediately:

```json
{
  "success": true,
  "lead_id": "<uuid>",
  "status": "assigned" | "pending",
  "matched_client": "<client uuid>" | null,
  "suburb": null,
  "state": null
}
```

---

## 7. Delivery (`submit-lead` → `deliver-webhook`, fire-and-forget)

If a client was matched, `submit-lead` fires `functions.invoke('deliver-webhook', { lead_id, client_id })` asynchronously — the HTTP response is already returned to the caller before delivery completes.

`deliver-webhook` steps:

**Step 1** — Fetch full `ppl_leads` row + full `clients` row in parallel.

**Step 2** — Build content:
- Email HTML (dark-themed table)
- Email plain-text preview
- SMS body

All include: Name, Phone, Email, Postcode, Type, Source, Homeowner, Quarterly Bill, Interested In, Timeline, Notes (`custom_fields`).

**Step 3** — Deliver based on client configuration:

If the client has `ql_hq_company_id` set, the `delivery_configs` table is consulted for that company's channels (email, SMS, webhook). These override the standard `delivery_method`.

Otherwise, `delivery_method` controls:

| `delivery_method` | Action |
|---|---|
| `email` | Sends via Resend API to `delivery_email` |
| `phone` | Sends SMS via Twilio to `delivery_phone` |
| `email_and_phone` | Sends both in parallel |
| `crm` | POSTs full lead JSON to `client_webhook` URL |
| *(fallback)* | Email if `delivery_email` set, else fail |

CC delivery is supported via `delivery_email_cc` on the client record.

**Step 4** — Update `ppl_leads`:
- On any success: `status = 'delivered'`, `delivered_at = now()`, `delivery_error = null`
- On all failures: `delivery_error = <error message>`

**Step 5** — Increment `clients.leads_delivered` via `increment_leads_delivered(p_client_id)` RPC (atomic SQL UPDATE). Falls back to non-atomic manual increment if RPC fails.

**Step 5b — Order Complete Check** — If `leads_delivered` has reached `total_leads_purchased`, an order-complete notification is sent to `contact@quoteleads.com.au`.

**Step 6** — Admin notification — sends a per-lead confirmation email to `RESEND_FROM_EMAIL` on success (best-effort, non-blocking).

Every delivery attempt writes a row to `lead_delivery_log`:

```
lead_id, client_id, method, destination, message_preview,
response_code, response_body, status, delivered_at
```

Log `method` values: `email`, `sms`, `webhook`, `quoteleads_hq`, `unknown`, `none`.

---

## 8. QuoteLeads HQ Forward (parallel, fire-and-forget)

Runs **in parallel** with `deliver-webhook` if the matched client has:
- `ql_hq_company_id` set, **OR**
- `has_quoteleads_platform_account = true` **AND** `hq_bearer_token` set

POSTs to `https://api.quoteleadshq.com/v1/leads` with the bearer token (falls back to service role key if no token is stored). Retries up to 2 times with 500 ms backoff on non-2xx.

Payload sent:

```json
{
  "name": "...",
  "email": "...",
  "phone": "...",
  "postcode": "...",
  "lead_type": "...",
  "source": "...",
  "custom_fields": "...",
  "company_id": "<ql_hq_company_id or null>"
}
```

Writes its own row to `lead_delivery_log` with `method = 'quoteleads_hq'`.

---

## 9. Lead Lifecycle States

```
pending  →  assigned  →  delivered
                    ↘
                     (delivery failure: delivery_error set, status stays assigned)
```

`mark_lead_scrubbed(lead_id)` — atomically:
- Sets `status = 'scrubbed'`
- Decrements `clients.leads_delivered` (if was delivered)
- Increments `clients.leads_scrubbed` (replacement lead owed)

`mark_lead_delivered(lead_id, note?)` — atomically:
- Sets `status = 'delivered'`
- Increments `clients.leads_delivered` (idempotent — only if not already delivered)
- Optionally appends a note to `delivery_audit_log` JSONB array

---

## 10. Key Tables Summary

| Table | Purpose |
|---|---|
| `ppl_leads` | One row per inbound lead; tracks assignment, delivery, status |
| `clients` | PPL buyers; holds caps, postcodes, niche, delivery config |
| `lead_delivery_log` | Audit trail of every delivery attempt |
| `delivery_configs` | Per-QL-HQ-company channel overrides (email, sms_number, webhook_url) |

Client fields that drive matching & delivery:

| Field | Role |
|---|---|
| `type = 'ppl'` | Marks as a PPL buyer |
| `stage = 'active_client'` | Must be active to receive leads |
| `niche` / `active_niches[]` | Which lead types this client accepts |
| `postcodes[]` | Postcode whitelist (must be non-empty to receive any leads) |
| `weekly_cap` / `monthly_cap` | Rate limits |
| `total_leads_purchased` | Total order size |
| `leads_delivered` | Running delivered count (auto-incremented) |
| `leads_scrubbed` | Running scrubbed count |
| `delivery_method` | `email` / `phone` / `email_and_phone` / `crm` |
| `delivery_email` / `delivery_email_cc` | Email delivery destinations |
| `delivery_phone` | SMS delivery destination |
| `client_webhook` | CRM webhook URL |
| `ql_hq_company_id` | Links client to a QL-HQ company (enables delivery_configs routing + HQ forward) |
| `has_quoteleads_platform_account` + `hq_bearer_token` | Alternative HQ platform forwarding path |
