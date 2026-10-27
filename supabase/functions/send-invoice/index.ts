/**
 * send-invoice - the Send button on the Invoices screen.
 *
 * The browser builds the PDF exactly as the PDF button would and sends it here
 * with the email the operator approved in the preview (to, subject, message).
 * This function decides what must not be decided in a browser: that the caller
 * is an operator, which address it goes out from and replies come back to,
 * and the invoice's sent stamp, which is only written once Resend has accepted
 * the message.
 *
 * Nothing sends an invoice on its own: drafts made by the billing reminders
 * stay drafts until someone presses Send and confirms.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import '../_shared/no-em-dash.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Plain text as a person would have typed it, not a marketing template. */
function bodyToHtml(text: string): string {
  const paras = String(text).split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:600px;margin:0 auto;padding:24px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1a1a20">
${paras}
</div></body></html>`
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/

/** Resend accepts up to 40MB; an invoice PDF is tens of KB. */
const MAX_PDF_BYTES = 5 * 1024 * 1024

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim()
    if (!token) return json({ error: 'Missing authorization' }, 401)

    // Operators only: the same gate as every outreach and billing action.
    const asUser = createClient(URL_, ANON || SERVICE, { global: { headers: { Authorization: `Bearer ${token}` } } })
    const { error: opErr } = await asUser.rpc('jarvis_assert_operator')
    if (opErr) return json({ error: 'Not allowed' }, 403)
    const { data: { user } } = await asUser.auth.getUser(token)

    const input = await req.json().catch(() => ({})) as {
      invoice_id?: string; to?: string; subject?: string; message?: string; pdf_base64?: string
    }
    const to = String(input.to ?? '').trim().toLowerCase()
    const subject = String(input.subject ?? '').trim()
    const message = String(input.message ?? '').trim()
    const pdf = String(input.pdf_base64 ?? '')

    if (!input.invoice_id) return json({ error: 'invoice_id is required' }, 400)
    if (!EMAIL_RE.test(to)) return json({ error: 'That email address does not look right' }, 400)
    if (!subject || subject.length > 200) return json({ error: 'Add a subject (200 characters at most)' }, 400)
    if (!message || message.length > 5000) return json({ error: 'Add a message (5000 characters at most)' }, 400)
    if (!pdf || pdf.length * 0.75 > MAX_PDF_BYTES) return json({ error: 'The invoice PDF is missing or too large' }, 400)
    // A real PDF starts "%PDF", which is "JVBER" in base64.
    if (!pdf.startsWith('JVBER')) return json({ error: 'The attachment is not a PDF' }, 400)

    const db = createClient(URL_, SERVICE)
    const { data: inv, error: invErr } = await db.from('invoices')
      .select('id, invoice_number, status').eq('id', input.invoice_id).maybeSingle()
    if (invErr || !inv) return json({ error: 'Invoice not found' }, 404)

    const { data: bset } = await db.from('business_settings')
      .select('business_name, sales_from_email, sales_reply_to_email').limit(1).maybeSingle()
    const fromEmail = String(bset?.sales_from_email ?? '').trim() || Deno.env.get('RESEND_FROM_EMAIL')
    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!fromEmail || !apiKey) return json({ error: 'Email is not configured' }, 500)
    const fromName = String(bset?.business_name ?? '').trim() || 'QuoteLeads'
    // Replies go to the configured address, else to whoever pressed Send.
    const replyTo = String(bset?.sales_reply_to_email || user?.email || '').trim()

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to,
        subject,
        html: bodyToHtml(message),
        text: message,
        ...(EMAIL_RE.test(replyTo) ? { reply_to: replyTo } : {}),
        attachments: [{ filename: `${inv.invoice_number || 'invoice'}.pdf`, content: pdf }],
      }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('resend error:', res.status, JSON.stringify(payload))
      return json({ error: 'The email provider rejected the message. Nothing was sent.' }, 502)
    }

    // Only now is it stamped, so a failed send leaves the invoice as it was.
    // A paid invoice keeps its status; resending it only updates the stamp.
    const now = new Date().toISOString()
    const { error: updErr } = await db.from('invoices').update({
      sent_at: now, sent_to: to, updated_at: now,
      ...(inv.status === 'paid' ? {} : { status: 'sent' }),
    }).eq('id', inv.id)
    if (updErr) console.error('invoice stamp failed after send:', updErr.message)

    return json({ ok: true, to, reply_to: replyTo || null, sent_at: now })
  } catch (err) {
    console.error('send-invoice error:', err)
    return json({ error: 'Internal server error' }, 500)
  }
})
