/**
 * ps-meta-sync
 *
 * Fetches LIFETIME spend for specified Meta ad account campaigns and stores
 * the result in ps_ad_accounts.
 *
 * Required Supabase Edge Function secrets:
 *   META_ACCESS_TOKEN – Meta Graph API access token (already set)
 *
 * POST body: { account_id: string, campaign_ids: string[], label?: string }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const metaToken = Deno.env.get("META_ACCESS_TOKEN");
    if (!metaToken) return json({ error: "META_ACCESS_TOKEN not configured" }, 503);

    const body = await req.json();
    const { account_id, campaign_ids, label } = body as {
      account_id: string;
      campaign_ids: string[];
      label?: string;
    };

    if (!account_id || !campaign_ids || campaign_ids.length === 0) {
      return json({ error: "account_id and campaign_ids required" }, 400);
    }

    type CampResult = {
      campaign_id: string;
      success: boolean;
      spend?: number;
      error?: string;
    };

    const results: CampResult[] = [];
    let totalSpend = 0;

    for (const cid of campaign_ids) {
      try {
        // Fetch lifetime spend
        // Note: Meta Graph API requires the token as a query parameter (standard Meta API pattern)
        const url =
          `https://graph.facebook.com/v21.0/${encodeURIComponent(cid)}/insights?fields=spend&date_preset=lifetime&access_token=${metaToken}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.error) {
          results.push({ campaign_id: cid, success: false, error: data.error.message });
          continue;
        }

        const spend = data.data && data.data.length > 0
          ? parseFloat(data.data[0].spend || "0")
          : 0;

        totalSpend += spend;
        results.push({ campaign_id: cid, success: true, spend });
      } catch (err) {
        results.push({
          campaign_id: cid,
          success: false,
          error: err instanceof Error ? err.message : "fetch error",
        });
      }
    }

    // Upsert into ps_ad_accounts
    const { data: existing } = await supabase
      .from("ps_ad_accounts")
      .select("id")
      .eq("account_id", account_id)
      .limit(1)
      .single();

    const now = new Date().toISOString();
    const failed = results.filter((r) => !r.success);
    const syncError = failed.length > 0
      ? failed.map((r) => `${r.campaign_id}: ${r.error}`).join("; ")
      : null;

    if (existing) {
      const updatePayload: Record<string, unknown> = {
        campaign_ids,
        lifetime_spend: totalSpend,
        last_synced_at: now,
        sync_error: syncError,
        updated_at: now,
      };
      if (label) updatePayload.label = label;
      await supabase.from("ps_ad_accounts").update(updatePayload).eq("id", existing.id);
    } else {
      await supabase.from("ps_ad_accounts").insert([{
        account_id,
        label: label || "PS Ad Account",
        campaign_ids,
        lifetime_spend: totalSpend,
        last_synced_at: now,
        sync_error: syncError,
      }]);
    }

    return json({
      success: true,
      account_id,
      total_lifetime_spend: totalSpend,
      campaign_count: campaign_ids.length,
      succeeded: results.filter((r) => r.success).length,
      failed: failed.length,
      results,
      sync_error: syncError,
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Internal error" },
      500,
    );
  }
});
