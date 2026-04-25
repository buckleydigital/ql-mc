import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@13?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalisePhone(raw: string): string | null {
  let p = (raw || "").replace(/[\s\-().]/g, "");
  if (p.startsWith("04")) p = "+61" + p.slice(1);
  else if (p.startsWith("614")) p = "+" + p;
  else if (p.startsWith("61") && !p.startsWith("+")) p = "+" + p;
  if (/^\+614[0-9]{8}$/.test(p)) return p;
  return p || null; // Return cleaned value for non-AU numbers
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return new Response(JSON.stringify({ error: "Missing stripe-signature" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.text();
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: `Webhook signature verification failed: ${err instanceof Error ? err.message : err}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // 1. Fetch pending order
      const { data: pendingOrder } = await supabaseAdmin
        .from("pending_orders")
        .select("*")
        .eq("stripe_session_id", session.id)
        .eq("status", "pending")
        .limit(1)
        .single();

      if (!pendingOrder) {
        console.warn(`No pending order found for session ${session.id}`);
        return new Response(JSON.stringify({ received: true, warning: "no pending order found" }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. Extract order_data
      const od = pendingOrder.order_data as Record<string, string>;

      // 3. Normalise phone
      const normPhone = normalisePhone(od.phone || "");
      const normDeliveryPhone = normalisePhone(od.delivery_phone || od.phone || "");
      const nicheVal = od.niche || od.trade?.toLowerCase() || "";

      // 4. Upsert client
      const clientData = {
        type: "ppl",
        company_name: od.company || "",
        contact_name: [od.first_name, od.last_name].filter(Boolean).join(" "),
        email: od.email || "",
        phone: normPhone,
        stage: "active_client",
        niche: nicheVal,
        active_niches: [nicheVal],
        lead_price: parseFloat(od.price_per_lead) || 0,
        total_leads_purchased: parseInt(od.quantity) || 0,
        leads_delivered: 0,
        delivery_method: od.delivery_method || "email_and_phone",
        delivery_email: od.delivery_email || od.email || "",
        delivery_phone: normDeliveryPhone,
        postcodes: [] as string[],
        postcodes_radius: parseInt(od.radius) || 50,
        has_reordered: false,
      };

      // Use upsert with email as conflict target
      const { error: upsertError } = await supabaseAdmin
        .from("clients")
        .upsert(
          { ...clientData, created_at: new Date().toISOString() },
          { onConflict: "email", ignoreDuplicates: false },
        );

      if (upsertError) {
        console.error("Client upsert error:", upsertError.message);
        // If upsert fails (e.g., no unique constraint on email), try insert
        const { error: insertError } = await supabaseAdmin
          .from("clients")
          .insert([{ ...clientData, created_at: new Date().toISOString() }]);
        if (insertError) {
          console.error("Client insert fallback error:", insertError.message);
        }
      }

      // 5. Create task
      const tradeLabel = od.niche || od.trade || "";
      await supabaseAdmin.from("tasks").insert([{
        title: `New order — ${od.company} · ${od.quantity} x ${tradeLabel} leads`,
        assigned_to: "human",
        priority: "urgent",
        done: false,
        notes: "Auto-created from Stripe payment. Configure postcodes and link campaigns in PPL Clients panel.",
        created_at: new Date().toISOString(),
      }]);

      // 6. Mark pending order completed
      await supabaseAdmin
        .from("pending_orders")
        .update({ status: "completed" })
        .eq("stripe_session_id", session.id);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Stripe webhook error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
