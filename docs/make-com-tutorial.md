# Make.com → QuoteLeads: Lead Submission Tutorial

This tutorial walks through building a Make.com scenario that submits a lead to the QuoteLeads `submit-lead` endpoint. If the matched client has a QuoteLeads HQ account configured, the lead is automatically forwarded to QL-HQ as part of the same API call — no extra modules needed.

---

## Prerequisites

- Your Supabase project URL: `https://<project-ref>.supabase.co`
- Your Supabase **anon key** (found in Supabase → Project Settings → API)
- A `clients` row in your database with `ql_hq_company_id` set (or `has_quoteleads_platform_account = true` and `hq_bearer_token` set)
- The client's `postcodes` array must include the postcode you're testing with

---

## Scenario Overview

```
[Trigger]  →  [HTTP: POST submit-lead]  →  [Router]
                                               ├── assigned → [success path]
                                               └── pending  → [no match path]
```

---

## Step-by-Step

### 1. Add a Trigger

Use whichever trigger fits your source:

| Source | Module to use |
|---|---|
| Typeform / Tally | **Typeform: Watch Responses** / **Webhooks: Custom webhook** |
| Facebook Lead Ads | **Facebook Lead Ads: Watch new leads** |
| CRM event | Your CRM's trigger module |
| Manual test | **Webhooks: Custom webhook** (generate a URL, POST to it) |

---

### 2. Add an HTTP Module — POST to submit-lead

Add a **HTTP → Make a request** module after your trigger.

**Settings:**

| Setting | Value |
|---|---|
| URL | `https://<project-ref>.supabase.co/functions/v1/submit-lead` |
| Method | `POST` |
| Headers | See below |
| Body type | `Raw` |
| Content type | `application/json` |
| Body | See below |

**Headers** (add each as a separate row):

| Key | Value |
|---|---|
| `Authorization` | `Bearer <your-anon-key>` |
| `apikey` | `<your-anon-key>` |
| `Content-Type` | `application/json` |

**Body** — map fields from your trigger:

```json
{
  "name": "{{1.name}}",
  "email": "{{1.email}}",
  "phone": "{{1.phone}}",
  "postcode": "{{1.postcode}}",
  "lead_type": "solar",
  "source": "make-scenario",
  "is_homeowner": true,
  "avg_quarterly_bill": "{{1.quarterly_bill}}",
  "purchase_timeline": "{{1.timeline}}"
}
```

Replace `{{1.field}}` with the actual field mappings from your trigger module. `lead_type` can be hardcoded per scenario or mapped dynamically.

> Any fields not in the named whitelist (`name`, `email`, `phone`, `postcode`, `lead_type`, `niche`, `source`, `is_homeowner`, `avg_quarterly_bill`, `interested_in`, `purchase_timeline`) are automatically captured in `custom_fields`.

---

### 3. Parse the Response

Enable **Parse response** on the HTTP module (or add a **JSON: Parse JSON** module after it).

The response has this shape:

```json
{
  "success": true,
  "lead_id": "uuid-...",
  "status": "assigned",
  "matched_client": "client-uuid-...",
  "suburb": null,
  "state": null
}
```

| `status` value | Meaning |
|---|---|
| `assigned` | Lead matched a client — delivery (and QL-HQ forward if configured) is underway |
| `pending` | No matching client found — lead is stored for manual review |
| `duplicate` | Same phone/email + lead_type seen in the last 7 days — no new record created |

---

### 4. Add a Router (optional but recommended)

Add a **Router** after the HTTP module to branch on `status`:

**Branch 1 — assigned**
- Filter: `{{2.status}}` = `assigned`
- Action: update your CRM, send a Slack notification, etc.

**Branch 2 — pending / duplicate**
- Filter: `{{2.status}}` != `assigned`
- Action: flag in a spreadsheet, alert your ops team, etc.

---

### 5. How QL-HQ Forwarding Works (automatic)

You do **not** need a separate module for QL-HQ. The `submit-lead` function handles it automatically:

1. The lead is matched to a client.
2. If that client has `ql_hq_company_id` set **or** `has_quoteleads_platform_account = true` with a `hq_bearer_token`, a fire-and-forget POST is sent to `https://api.quoteleadshq.com/v1/leads` with up to 2 retries.
3. The result is logged in `lead_delivery_log` with `method = 'quoteleads_hq'`.

If you see `status: "assigned"` in the response but no HQ delivery, check:
- The matched client's `ql_hq_company_id` or bearer token fields in the `clients` table
- The `lead_delivery_log` table for a row with `method = 'quoteleads_hq'` and `status = 'failed'`

---

## Error Handling

| HTTP status | Error body | Cause |
|---|---|---|
| 400 | `missing_lead_type` | `lead_type`/`niche` not sent |
| 400 | `missing_name` | Name empty or missing |
| 400 | `invalid_phone` | Phone not a valid AU number |
| 400 | `invalid_postcode` | Postcode not exactly 4 digits |
| 400 | `missing_email` / `invalid_email` | Email missing or malformed |
| 200 | `status: "duplicate"` | Duplicate within same lead_type in last 7 days |
| 500 | `error: "..."` | Unexpected server error |

Add an **Error handler** route on the HTTP module set to `Resume`, then check `{{2.error}}` to handle specific cases (e.g. retry on 500, skip on duplicate).

---

## Testing

1. In Make, open the scenario and click **Run once**.
2. Manually trigger your source (or POST to the custom webhook URL).
3. In the HTTP module output, confirm `status = "assigned"` and a `lead_id` is returned.
4. In Supabase → Table Editor → `ppl_leads`, find the row and confirm `assigned_client_id` is set.
5. In `lead_delivery_log`, look for rows with your `lead_id` — you should see one for the standard delivery method and one for `quoteleads_hq` if HQ forwarding is configured.
