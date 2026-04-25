import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@13?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    const body = await req.json();
    const {
      trade, subtype, postcode, radius, quantity, price_per_lead,
      first_name, last_name, company, email, phone,
      delivery_method, delivery_email, delivery_phone, niche,
      success_url, cancel_url,
    } = body;

    const totalAmount = Math.round((parseFloat(price_per_lead) || 0) * (parseInt(quantity) || 0) * 100);
    const nicheLabel = niche || trade || "";
    const qtyNum = parseInt(quantity) || 0;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "aud",
            product_data: {
              name: `${qtyNum} × ${nicheLabel} leads`,
              description: `${company || "Client"} — ${postcode} (${radius || 50}km radius)`,
            },
            unit_amount: totalAmount,
          },
          quantity: 1,
        },
      ],
      success_url: success_url || "https://quoteleads.com.au/thank-you",
      cancel_url: cancel_url || "https://quoteleads.com.au/pricing",
      metadata: {
        trade: trade || "",
        niche: nicheLabel,
        subtype: subtype || "",
        postcode: postcode || "",
        radius: String(radius || 50),
        quantity: String(qtyNum),
        price_per_lead: String(price_per_lead || 0),
        company: company || "",
        first_name: first_name || "",
        last_name: last_name || "",
        email: email || "",
        phone: phone || "",
        delivery_method: delivery_method || "email_and_phone",
        delivery_email: delivery_email || email || "",
        delivery_phone: delivery_phone || phone || "",
      },
    });

    // Write to pending_orders table
    try {
      const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      await supabaseAdmin.from("pending_orders").insert([{
        stripe_session_id: session.id,
        order_data: {
          trade, subtype, postcode, radius, quantity, price_per_lead,
          first_name, last_name, company, email, phone,
          delivery_method, delivery_email, delivery_phone, niche,
        },
        status: "pending",
      }]);
    } catch (insertErr) {
      console.error("Failed to insert pending_order:", insertErr);
      // Do not fail the response — Stripe session is the priority
    }

    return new Response(JSON.stringify({ sessionId: session.id, url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
