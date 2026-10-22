// =============================================================================
// impersonate-rep - let an admin view the dashboard AS one of their sales reps
// =============================================================================
// Verifies the caller is an admin (NOT a sales rep), confirms the target is a
// sales rep, then mints a real session for that rep server-side (magic-link →
// verifyOtp, no email sent) and returns it. The client swaps to that session so
// every query is RLS-scoped exactly as the rep sees it, and can restore its
// saved admin session to switch back.
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated" }, 401);

    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });

    // Resolve + authorise the caller: must be a signed-in NON-rep (admin/owner).
    const { data: { user: caller }, error: callerErr } = await userClient.auth.getUser(token);
    if (callerErr || !caller) return json({ error: "Not authenticated" }, 401);
    if (caller.app_metadata?.account_type === "sales_rep") {
      return json({ error: "Forbidden: reps cannot impersonate" }, 403);
    }

    const { rep_user_id } = await req.json().catch(() => ({})) as { rep_user_id?: string };
    if (!rep_user_id) return json({ error: "rep_user_id is required" }, 400);

    // Confirm the target really is a sales rep before minting a session for them.
    const { data: target, error: targetErr } = await adminClient.auth.admin.getUserById(rep_user_id);
    if (targetErr || !target?.user) return json({ error: "Rep not found" }, 404);
    if (target.user.app_metadata?.account_type !== "sales_rep") {
      return json({ error: "Target user is not a sales rep" }, 403);
    }
    const email = target.user.email;
    if (!email) return json({ error: "Rep has no email on file" }, 400);

    // Step 1: generate a magic-link token (sends no email).
    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError || !linkData?.properties?.hashed_token) {
      console.error("generateLink error:", linkError?.message || "no hashed_token");
      return json({ error: "Failed to generate impersonation token" }, 500);
    }

    // Step 2: exchange it for a live session, server-side.
    const { data: otpData, error: otpError } = await adminClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "email",
    });
    if (otpError || !otpData?.session) {
      console.error("verifyOtp error:", otpError?.message || "no session");
      return json({ error: "Failed to create impersonation session" }, 500);
    }

    return json({ session: otpData.session, rep: { id: target.user.id, email, name: target.user.user_metadata?.name || null } });
  } catch (err) {
    console.error("impersonate-rep error:", err);
    return json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
  }
});
