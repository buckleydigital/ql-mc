import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Verify the caller is an authenticated user
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { error: authError } = await userClient.auth.getUser();
  if (authError) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Webhook URL and token are server-side secrets — never exposed to the client
  const webhookUrl = Deno.env.get('MAKE_WEBHOOK_URL');
  const webhookToken = Deno.env.get('MAKE_WEBHOOK_TOKEN');
  if (!webhookUrl || !webhookToken) {
    return new Response(JSON.stringify({ error: 'Webhook not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Inject the token server-side before forwarding
  const payload = { ...body, _token: webhookToken };

  const makeRes = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await makeRes.text();

  return new Response(JSON.stringify({ ok: makeRes.ok, response: text }), {
    status: makeRes.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
