# ql-mc

Mission Control (mc.quoteleadshq.com), served by GitHub Pages from `main`.
The backend (Supabase edge functions and migrations) lives in the private
`buckleydigital/ql-backend` repo; see BACKEND.md.

## Where things are

- `index.html` - the page markup only: panels, modals, navigation.
- `assets/mc/mc.css` - all the styles.
- `assets/mc/*.js` - the app, one file per area, loaded in number order.

| File | Area |
|---|---|
| `00-layout.js` | Bottom-nav padding on phones |
| `01-core.js` | Supabase client, login, helpers (toast, modals), navigation, impersonation |
| `02-ppl-leads-tasks.js` | Role-based UI, PPL lead delivery, test leads, SMS, tasks |
| `03-pipeline-board.js` | Kanban board, drag and drop, follow-up rule |
| `04-scoreboard.js` | Scoreboard: sales metrics, Meta ads, guardrails, LTV, rep stats |
| `05-pipeline.js` | Sales Pipeline: leads list, sales emails and templates, Edit lead, HQ accounts |
| `06-hiring.js` | Hiring pipeline |
| `07-ppl-clients.js` | PPL clients |
| `08-broadcast.js` | Bulk SMS / broadcast |
| `09-billing.js` | CPL editor, managed payments, PPL and managed order logs |
| `10-managed-clients.js` | Managed clients, fulfilment, Edit client, CSMs, guarantees |
| `11-meta-campaigns.js` | Meta campaigns, ad accounts, insights sync |
| `12-finance.js` | Financials, subscriptions, expenses, spend log, goals, charts |
| `13-files-sops.js` | Files, SOPs, templates |
| `14-settings-invoices.js` | Business settings, invoices and PDFs |
| `15-alerts.js` | Alerts tray |
| `16-team-reps.js` | Team members, pay rates, sales reps, auto-assign |
| `17-conversations-settings.js` | SMS conversations, Twilio and AI agent settings, QuoteLeadsAI settings |
| `18-outreach.js` | Cold outreach: niches, prospects, sending, batches, stats; QuoteLeadsAI notes, posts, memory, log |
| `19-pcal.js` | Client campaign action logs |
| `20-assistant.js` | QuoteLeadsAI assistant panel |
| `21-managed-ads.js` | Managed ads launch and watch |

## Working on it

- The files are plain scripts sharing one global scope, exactly as when they
  were one inline script: a function in one file can call a function in any
  other. Each starts with `'use strict'`.
- Code that runs the moment a file loads (not inside a function) can only use
  things from the same or an earlier file. Everything else - event handlers,
  functions called after login - can use anything.
- No build step. Edit, commit, push; Pages serves it within a few minutes
  (browsers may cache a file for up to 10 minutes).
