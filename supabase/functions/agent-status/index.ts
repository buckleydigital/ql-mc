// agent-status — receives `started` / `finished` pings from Make.com scenarios.
//
// Each scenario has two HTTP POST modules (top + tail). The payload is
// intentionally tiny so it's trivial to paste into Make:
//
//   { "agent": "smsagent", "scenario": "Inbound SMS Reply", "status": "started" }
//   { "agent": "smsagent", "scenario": "Inbound SMS Reply", "status": "finished",
//     "log":    "Replied to lead 123 — quote sent" }
//
// What this function does on every ping:
//   1. Append one row to public.agent_runs (agent, scenario, status, log).
//   2. Update public.agents.busy + current_stat so the HQ Fleet Map shows
//      a live "Running — <scenario>" / "Last run · <scenario> · <status>"
//      label and the sprite walks while busy.
//
// Make scenarios cannot present a Supabase JWT, so this function is marked
// `verify_jwt = false` in supabase/config.toml.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const agent    = typeof body.agent    === "string" ? body.agent.trim().toLowerCase() : "";
  const scenario = typeof body.scenario === "string" ? body.scenario.trim() : "";
  const status   = typeof body.status   === "string" ? body.status.trim().toLowerCase() : "";
  const log      = typeof body.log      === "string" ? body.log.slice(0, 2000) : null;

  if (!agent)  return jsonResponse({ error: "agent is required" }, 400);
  if (!status) return jsonResponse({ error: "status is required" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1) Append the run-log row.
  const { error: insertErr } = await supabase.from("agent_runs").insert([{
    agent,
    scenario: scenario || null,
    status,
    log,
  }]);
  if (insertErr) {
    return jsonResponse({ error: insertErr.message }, 500);
  }

  // 2) Update the live Fleet Map status.
  //    `started`  → busy=true,  current_stat = "Running — <scenario>"
  //    otherwise  → busy=false, current_stat = "Last run · <scenario> · <status>"
  const isStarted = status === "started" || status === "start" || status === "running";
  const label = isStarted
    ? `Running — ${scenario || "scenario"}`
    : `Last run · ${scenario || "scenario"} · ${status}`;

  // Best-effort — don't fail the request if the agents row is missing.
  await supabase.from("agents").update({
    busy: isStarted,
    current_stat: label,
    current_task: scenario || null,
    updated_at: new Date().toISOString(),
  }).eq("id", agent);

  return jsonResponse({ ok: true, agent, status });
});
