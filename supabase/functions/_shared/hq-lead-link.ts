// Links a ql-mc ppl_lead to the lead it became in ql-hq. submit-lead posts each
// lead to ql-hq's API and keeps the response in lead_delivery_log, and that
// response starts with the new ql-hq lead's id: {"data":{"id":"<uuid>",...}.
// The body is cut at 500 characters, so the id is read with a pattern rather
// than JSON.parse.

// deno-lint-ignore no-explicit-any
type Db = any;

const HQ_ID_RE = /"data"\s*:\s*\{\s*"id"\s*:\s*"([0-9a-f-]{36})"/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The ql-hq lead id for a ql-mc lead, or null if it never reached ql-hq.
export async function hqLeadIdFor(db: Db, mcLeadId: string): Promise<string | null> {
  const { data } = await db
    .from('lead_delivery_log')
    .select('response_body')
    .eq('lead_id', mcLeadId)
    .eq('method', 'quoteleads_hq')
    .eq('status', 'delivered')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const m = HQ_ID_RE.exec((data?.response_body as string | undefined) ?? '');
  return m ? m[1].toLowerCase() : null;
}

// The ql-mc lead a ql-hq lead id came from, or null.
export async function mcLeadIdFor(db: Db, hqLeadId: string): Promise<string | null> {
  if (!UUID_RE.test(hqLeadId)) return null;
  const { data } = await db
    .from('lead_delivery_log')
    .select('lead_id')
    .eq('method', 'quoteleads_hq')
    .eq('status', 'delivered')
    .like('response_body', `%"id":"${hqLeadId.toLowerCase()}"%`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.lead_id as string | undefined) ?? null;
}
