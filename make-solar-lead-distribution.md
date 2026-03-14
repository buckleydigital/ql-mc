# Make.com — Solar Lead Distribution Scenario

## How it works

All the smart stuff happens in Supabase. Make's job is minimal:

1. Receive the lead from your ad form
2. Insert it into Supabase → get back a UUID
3. Call one database function → get back who to send to, how, and the pre-built email/SMS content
4. Route and send — that's it

The email HTML and SMS text are built entirely in Postgres using each client's
**Lead Notification Template**. Only fields with actual values appear. Blank
fields are skipped automatically. Each client or funnel can have completely
different fields.

```
[Webhook trigger]
      ↓
[Module 1] Insert lead into solar_leads → get UUID
      ↓
[Module 2] Call assign_solar_lead() → get delivery details + pre-built email/SMS
      ↓ (filter: assigned = false → [Module 6] notify you, stop)
[Module 3] Router on delivery_method
      ↓           ↓           ↓           ↓
  [email]    [phone]    [both]      [crm]
      ↓           ↓           ↓           ↓
[Module 4] Mark lead as "delivered" in solar_leads
```

---

## Before you build — set up each PPL client

In QL Mission Control, open each PPL client's Edit modal and fill in:

**Lead Delivery section:**
- **Postcodes Covered** — the postcodes this client bought leads for (comma-separated)
- **Delivery Method** — Email / Phone / Email & Phone / CRM
- **Delivery Email** — where lead emails go (can differ from their contact email)
- **Delivery Phone** — mobile number for SMS

**Lead Notification Template section:**
An ordered JSON array. Each item is `{"key": "...", "label": "..."}` where:
- `key` is the field name (see built-in keys below, or any custom key from your ad form)
- `label` is what appears in the email/SMS next to the value

```json
[
  {"key": "name",          "label": "Name"},
  {"key": "email",         "label": "Email"},
  {"key": "phone",         "label": "Phone"},
  {"key": "postcode",      "label": "Postcode"},
  {"key": "suburb",        "label": "Suburb"},
  {"key": "monthly_bill",  "label": "Monthly Bill"},
  {"key": "property_type", "label": "Property Type"},
  {"key": "interested_in", "label": "Interested In"}
]
```

**Built-in field keys** (standard solar_leads columns):
`name` `email` `phone` `postcode` `address` `suburb` `state`
`property_type` `roof_type` `monthly_bill` `system_size` `interested_in`

**Custom field keys** — any extra field your ad form sends gets stored in
`custom_data` on the lead. Just use the same key name in the template:
```json
{"key": "roof_age",          "label": "Roof Age"},
{"key": "current_provider",  "label": "Current Provider"},
{"key": "num_occupants",     "label": "People in Home"}
```

If a client has no template set, the system falls back to name + email + phone + postcode only.

---

## Supabase setup

**Service role key** — go to Supabase Dashboard → Settings → API → copy the
`service_role` secret key. You'll use this in all HTTP module headers.
Never use the anon key here — it won't have permission to call the RPC function.

**Run the migrations** — paste sections 8–11 from `migrations.sql` into
Supabase → SQL Editor → New Query and run.

---

## Module 1 — Insert lead into Supabase

**Type:** HTTP → Make a request

| Setting     | Value |
|-------------|-------|
| URL         | `https://YOUR-PROJECT-REF.supabase.co/rest/v1/solar_leads` |
| Method      | POST |
| Header      | `apikey: YOUR_SERVICE_ROLE_KEY` |
| Header      | `Authorization: Bearer YOUR_SERVICE_ROLE_KEY` |
| Header      | `Content-Type: application/json` |
| Header      | `Prefer: return=representation` |
| Parse response | Yes |

**Body (raw JSON):**

Map fields from your trigger (webhook, Facebook Lead Ad, etc.) to these names.
Standard fields go in their own keys. Any extra funnel fields go inside
`custom_data` as a JSON object — the template system will pick them up.

```json
{
  "name":          "{{trigger.full_name}}",
  "email":         "{{trigger.email}}",
  "phone":         "{{trigger.phone_number}}",
  "postcode":      "{{trigger.postcode}}",
  "suburb":        "{{trigger.suburb}}",
  "state":         "{{trigger.state}}",
  "address":       "{{trigger.address}}",
  "property_type": "{{trigger.property_type}}",
  "monthly_bill":  {{trigger.monthly_bill}},
  "interested_in": "{{trigger.interested_in}}",
  "source":        "make",
  "custom_data": {
    "roof_age":         "{{trigger.roof_age}}",
    "current_provider": "{{trigger.current_provider}}"
  }
}
```

Remove any keys you don't have. The response gives you the new row — you need
`{{1.id}}` (the UUID) for the next module. Make sure Parse response is ON.

---

## Module 2 — Assign lead + get pre-built payload

**Type:** HTTP → Make a request

| Setting     | Value |
|-------------|-------|
| URL         | `https://YOUR-PROJECT-REF.supabase.co/rest/v1/rpc/assign_solar_lead` |
| Method      | POST |
| Header      | `apikey: YOUR_SERVICE_ROLE_KEY` |
| Header      | `Authorization: Bearer YOUR_SERVICE_ROLE_KEY` |
| Header      | `Content-Type: application/json` |
| Parse response | Yes |

**Body:**
```json
{
  "p_lead_id":  "{{1.id}}",
  "p_postcode": "{{trigger.postcode}}"
}
```

**What comes back when a client is found:**
```json
{
  "assigned":        true,
  "client_id":       "uuid...",
  "company_name":    "SunPower QLD",
  "delivery_method": "email_and_phone",
  "delivery_email":  "leads@sunpower.com.au",
  "delivery_phone":  "+61412345678",
  "custom_fields":   {},
  "email_subject":   "New Lead — Jane Smith (2000)",
  "email_html":      "<div>...pre-built HTML email...</div>",
  "sms_body":        "Name: Jane Smith | Phone: 0412345678 | Postcode: 2000 | ..."
}
```

**What comes back when no client matched:**
```json
{
  "assigned": false,
  "reason":   "no_matching_client"
}
```

Add a **filter** after this module: continue only if `{{2.assigned}}` = `true`.
Everything else falls to the error path (Module 6).

---

## Module 3 — Router

**Type:** Flow Control → Router

Add four routes. Each route has a filter on `{{2.delivery_method}}`:

| Route | Filter condition |
|-------|-----------------|
| A | `{{2.delivery_method}}` equals `email` |
| B | `{{2.delivery_method}}` equals `phone` |
| C | `{{2.delivery_method}}` equals `email_and_phone` |
| D | `{{2.delivery_method}}` equals `crm` |

---

### Route A — Email only

**Module:** Gmail → Send an Email (or SendGrid → Send Email)

| Field   | Value |
|---------|-------|
| To      | `{{2.delivery_email}}` |
| Subject | `{{2.email_subject}}` |
| Content | HTML |
| Body    | `{{2.email_html}}` |

That's it. Supabase already built the HTML for you.

---

### Route B — SMS only

**Module:** Twilio → Send an SMS

| Field | Value |
|-------|-------|
| To    | `{{2.delivery_phone}}` |
| Body  | `{{2.sms_body}}` |

---

### Route C — Email and SMS

Add both the Gmail module and the Twilio module in sequence on this route.
Use `{{2.email_subject}}`, `{{2.email_html}}`, `{{2.delivery_email}}` for email
and `{{2.delivery_phone}}`, `{{2.sms_body}}` for SMS.

---

### Route D — CRM webhook

**Module:** HTTP → Make a request

The client's CRM connection details live in their `custom_fields` JSON.
Typical pattern: `{"webhook_url": "https://crm.example.com/leads", "api_key": "xxx"}`

| Field  | Value |
|--------|-------|
| URL    | `{{2.custom_fields.webhook_url}}` |
| Method | POST |
| Header | `X-Api-Key: {{2.custom_fields.api_key}}` (or whatever the CRM needs) |
| Body   | `{{2.email_html}}` as HTML, or a full JSON payload built from the trigger data |

Each CRM client will be a bit different. For fully custom CRM integrations,
consider a sub-scenario or a dedicated scenario per client.

---

## Module 4 — Mark lead as delivered

Add this at the **end of every route** (after the send step).

**Type:** HTTP → Make a request

| Setting | Value |
|---------|-------|
| URL     | `https://YOUR-PROJECT-REF.supabase.co/rest/v1/solar_leads?id=eq.{{1.id}}` |
| Method  | PATCH |
| Header  | `apikey: YOUR_SERVICE_ROLE_KEY` |
| Header  | `Authorization: Bearer YOUR_SERVICE_ROLE_KEY` |
| Header  | `Content-Type: application/json` |
| Header  | `Prefer: return=minimal` |

**Body:**
```json
{
  "status":       "delivered",
  "delivered_at": "{{now}}"
}
```

---

## Module 5 — Error handler: lead failed to match

If Module 2 returns `assigned = false`, route to a notification.

**Type:** Gmail / Slack / whatever you prefer

Send yourself an alert:
```
No PPL client found for postcode {{trigger.postcode}}.
Lead: {{trigger.full_name}} ({{trigger.email}})
Check QL Mission Control — client may have run out of leads or postcodes not configured.
```

The lead remains in `solar_leads` with `status = 'pending'` so you can
manually review and reassign from the database.

---

## How the distribution logic works

When `assign_solar_lead` runs, it looks for a PPL client where ALL of these are true:
- `type = 'ppl'`
- `stage = 'active_client'`
- `leads_delivered + leads_scrubbed < total_leads_purchased` (still has leads to fill)
- The lead's postcode is in the client's `postcodes[]` array

Among all matching clients, it picks the one with the **oldest `last_lead_delivered_at`**
(the one who went the longest without a lead). This gives fair round-robin across
multiple clients covering the same postcode.

The database uses `FOR UPDATE SKIP LOCKED` so if two leads arrive at exactly the
same millisecond, Postgres guarantees they can't be assigned to the same client.
One waits, the other proceeds — no race conditions.
