# Make.com — Solar Lead Distribution Scenario

## Overview

This scenario receives a new solar lead (from a Facebook Lead Ad, Google Form,
Typeform, etc.), inserts it into Supabase, atomically assigns it to the correct
PPL client based on postcode, increments their delivered count, then delivers
the lead via email, SMS, or both. CRM delivery uses a custom webhook branch.

```
[Webhook] → [Insert Lead] → [Assign Lead] → [Router] → [Email / SMS / CRM]
                                                      → [Mark Delivered]
```

---

## Module 1 — Custom Webhook (Trigger)

**Type:** Webhooks > Custom webhook

Configure this as your ad form's submission endpoint. The webhook receives the
raw lead data and kicks off the scenario.

**Expected payload (Facebook Lead Ads example):**
```json
{
  "name":          "Jane Smith",
  "email":         "jane@example.com",
  "phone":         "+61400000000",
  "postcode":      "2000",
  "address":       "123 Main St",
  "suburb":        "Sydney",
  "state":         "NSW",
  "property_type": "residential",
  "roof_type":     "tile",
  "monthly_bill":  250,
  "interested_in": "solar"
}
```

> For Facebook Lead Ads, use the **Facebook Lead Ads** trigger module instead
> and map fields to the structure above using Set Variables.

---

## Module 2 — Insert Lead into Supabase

**Type:** HTTP > Make a request

| Field       | Value                                                        |
|-------------|--------------------------------------------------------------|
| URL         | `https://<your-project>.supabase.co/rest/v1/solar_leads`    |
| Method      | POST                                                         |
| Headers     | `apikey: <service_role_key>`                                 |
|             | `Authorization: Bearer <service_role_key>`                   |
|             | `Content-Type: application/json`                             |
|             | `Prefer: return=representation`                              |
| Body (JSON) | See below                                                    |

**Body:**
```json
{
  "name":          "{{1.name}}",
  "email":         "{{1.email}}",
  "phone":         "{{1.phone}}",
  "postcode":      "{{1.postcode}}",
  "address":       "{{1.address}}",
  "suburb":        "{{1.suburb}}",
  "state":         "{{1.state}}",
  "property_type": "{{1.property_type}}",
  "roof_type":     "{{1.roof_type}}",
  "monthly_bill":  {{1.monthly_bill}},
  "interested_in": "{{1.interested_in}}",
  "source":        "make"
}
```

**Parse response:** Yes — map `{{2.id}}` as `lead_id` for the next module.

---

## Module 3 — Assign Lead (RPC call)

**Type:** HTTP > Make a request

This calls the `assign_solar_lead` PostgreSQL function atomically. It finds the
right client (active, covers the postcode, longest since their last delivery),
increments their `leads_delivered` counter, and returns delivery details.

| Field       | Value                                                             |
|-------------|-------------------------------------------------------------------|
| URL         | `https://<your-project>.supabase.co/rest/v1/rpc/assign_solar_lead` |
| Method      | POST                                                              |
| Headers     | `apikey: <service_role_key>`                                      |
|             | `Authorization: Bearer <service_role_key>`                        |
|             | `Content-Type: application/json`                                  |
| Body (JSON) | `{"p_lead_id": "{{2.id}}", "p_postcode": "{{1.postcode}}"}` |

**Response structure:**
```json
{
  "assigned":        true,
  "client_id":       "uuid",
  "company_name":    "SunPower Solutions",
  "delivery_method": "email_and_phone",
  "delivery_email":  "leads@sunpower.com.au",
  "delivery_phone":  "+61412345678",
  "custom_fields":   {}
}
```

If `assigned = false`, the lead has no matching active client. Set up an error
handler / notification for this case (see Module 7).

---

## Module 4 — Router

**Type:** Flow Control > Router

Add four routes based on `{{3.delivery_method}}`:

| Route | Condition                               |
|-------|-----------------------------------------|
| A     | `delivery_method` = `email`             |
| B     | `delivery_method` = `phone`             |
| C     | `delivery_method` = `email_and_phone`   |
| D     | `delivery_method` = `crm`               |

Routes A and B each go to a single module. Route C runs both email and SMS in
sequence (or use two parallel paths). Route D calls the client's webhook.

---

## Module 5A — Send Email (Gmail / SendGrid)

**Type:** Gmail > Send an Email  **or** SendGrid > Send Email

| Field   | Value                                                    |
|---------|----------------------------------------------------------|
| To      | `{{3.delivery_email}}`                                   |
| Subject | `New Solar Lead — {{1.name}} ({{1.postcode}})`           |
| Body    | See template below                                       |

**Email body template (HTML):**
```
<h2>New Solar Lead</h2>
<table>
  <tr><td><b>Name</b></td><td>{{1.name}}</td></tr>
  <tr><td><b>Phone</b></td><td>{{1.phone}}</td></tr>
  <tr><td><b>Email</b></td><td>{{1.email}}</td></tr>
  <tr><td><b>Postcode</b></td><td>{{1.postcode}}, {{1.suburb}} {{1.state}}</td></tr>
  <tr><td><b>Address</b></td><td>{{1.address}}</td></tr>
  <tr><td><b>Property</b></td><td>{{1.property_type}} — {{1.roof_type}} roof</td></tr>
  <tr><td><b>Monthly Bill</b></td><td>${{1.monthly_bill}}</td></tr>
  <tr><td><b>Interested in</b></td><td>{{1.interested_in}}</td></tr>
</table>
<p><i>Exclusive lead — distributed to {{3.company_name}} only.</i></p>
```

---

## Module 5B — Send SMS (Twilio)

**Type:** Twilio > Send an SMS

| Field | Value                                           |
|-------|-------------------------------------------------|
| To    | `{{3.delivery_phone}}`                          |
| Body  | See template below                              |

**SMS template:**
```
New Solar Lead for {{3.company_name}}:
{{1.name}} | {{1.phone}} | {{1.postcode}}
Bill: ${{1.monthly_bill}}/mo | {{1.property_type}}
Reply STOP to opt out.
```

---

## Module 5C — Email & Phone

Run **both** 5A and 5B in sequence on this route.

---

## Module 5D — CRM Webhook

**Type:** HTTP > Make a request

The client's CRM details are stored in `custom_fields` on their client record.
Common pattern: `{"webhook_url": "https://crm.example.com/leads", "api_key": "xxx"}`.

| Field   | Value                                   |
|---------|-----------------------------------------|
| URL     | `{{3.custom_fields.webhook_url}}`       |
| Method  | POST                                    |
| Headers | `X-Api-Key: {{3.custom_fields.api_key}}`|
| Body    | Full lead JSON from Module 1            |

Adapt this per client CRM. Each CRM client typically gets their own dedicated
scenario route or a sub-scenario.

---

## Module 6 — Mark Lead as Delivered

**Type:** HTTP > Make a request

Run this **after** all delivery routes converge (add a converger if using
parallel routes), regardless of which delivery method was used.

| Field       | Value                                                                    |
|-------------|--------------------------------------------------------------------------|
| URL         | `https://<your-project>.supabase.co/rest/v1/solar_leads?id=eq.{{2.id}}` |
| Method      | PATCH                                                                    |
| Headers     | `apikey: <service_role_key>`                                             |
|             | `Authorization: Bearer <service_role_key>`                               |
|             | `Content-Type: application/json`                                         |
| Body (JSON) | `{"status": "delivered", "delivered_at": "{{now}}"}` |

---

## Module 7 — No Match Handler (Error Route)

Add an **error handler** or a filter on Module 3 for `assigned = false`.

**Suggested action:** Send yourself a Slack/email notification:
```
No PPL client matched for postcode {{1.postcode}}.
Lead: {{1.name}} ({{1.email}})
```
The lead stays as `status = 'pending'` in `solar_leads` for manual review.

---

## Variables Reference

| Variable           | Source     | Description                           |
|--------------------|------------|---------------------------------------|
| `1.postcode`       | Webhook    | Lead's postcode                       |
| `2.id`             | Module 2   | UUID of the inserted solar_lead row   |
| `3.assigned`       | Module 3   | Boolean — was a client found?         |
| `3.delivery_method`| Module 3   | `email`, `phone`, `email_and_phone`, `crm` |
| `3.delivery_email` | Module 3   | Client's lead delivery email          |
| `3.delivery_phone` | Module 3   | Client's lead delivery phone (SMS)    |
| `3.custom_fields`  | Module 3   | JSON object for CRM config            |
| `3.company_name`   | Module 3   | Client name (for notifications)       |

---

## Supabase Service Role Key

Use the **service role** key (not the anon key) so Make can bypass RLS and
call the RPC function. Find it in:
`Supabase Dashboard → Settings → API → service_role secret`

Store it in Make as a **Connection** or environment variable — never hardcode
it in the scenario body.

---

## How Exclusive Lead Matching Works

The `assign_solar_lead` database function uses `FOR UPDATE SKIP LOCKED` which
means even if two leads arrive simultaneously, Postgres guarantees only one
client is assigned per lead. The client chosen is always the active PPL client
who:

1. Covers the lead's postcode (postcode is in their `postcodes[]` array)
2. Has leads remaining (`leads_delivered < total_leads_purchased`)
3. Has gone the longest since their last delivery (`last_lead_delivered_at ASC`)

This gives you a fair round-robin across multiple clients in the same area,
with exclusivity guaranteed at the database level.
