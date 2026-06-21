// =============================================================================
// sales-rep-api — admin management for the ql-mc "sales_rep" account type
// =============================================================================
// Every action here is OWNER-ONLY: the caller must be a full internal user.
// A sales_rep calling this function is rejected (403). Identity is verified
// server-side from the caller's JWT (app_metadata.account_type) via the
// service role — never trusted from the request body.
//
// Actions
//   list_reps        → roster + per-rep stats (assigned / won / calls / rates)
//   create_rep       → create an auth user (account_type=sales_rep) + roster row
//   set_password     → reset a rep's password
//   set_active       → enable / disable a rep (disable = ban login + unassign)
//   delete_rep       → delete the auth user + roster row + free their leads
//   get_config       → read auto-assign settings
//   set_config       → write auto-assign settings
//   auto_assign_now  → assign every currently-unassigned lead (least-loaded)
//
// The sales_rep's OWN data (their pipeline, contact logs, invoices, stats) is
// read straight from the tables in the browser under RLS — it never comes
// through here.
// =============================================================================
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CLOSED_STAGES = ["closed_won", "closed_lost", "churned"];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "Not authenticated" }, 401);

    // OWNER-ONLY: a sales rep may never reach the management API.
    if ((user.app_metadata as Record<string, unknown>)?.account_type === "sales_rep") {
      return json({ error: "Forbidden" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    // ── list_reps ────────────────────────────────────────────────────────────
    if (action === "list_reps") {
      const { data: reps } = await admin
        .from("sales_reps")
        .select("user_id, email, name, active, created_at")
        .order("created_at", { ascending: true });
      const ids = (reps || []).map((r: { user_id: string }) => r.user_id);

      // Pipeline ownership + outcomes.
      const { data: leads } = ids.length
        ? await admin.from("leads").select("id, owner_id, stage").in("owner_id", ids)
        : { data: [] as Array<Record<string, unknown>> };

      // Contact attempts (calls) for those leads → pickup / activity stats.
      const leadOwner: Record<string, string> = {};
      for (const l of leads || []) leadOwner[l.id as string] = l.owner_id as string;
      const leadIds = Object.keys(leadOwner);
      const { data: logs } = leadIds.length
        ? await admin.from("lead_contact_log").select("lead_id, contact_type, outcome").in("lead_id", leadIds)
        : { data: [] as Array<Record<string, unknown>> };

      const stat: Record<string, { assigned: number; open: number; won: number; lost: number; calls: number; answered: number }> = {};
      for (const id of ids) stat[id] = { assigned: 0, open: 0, won: 0, lost: 0, calls: 0, answered: 0 };
      for (const l of leads || []) {
        const s = stat[l.owner_id as string]; if (!s) continue;
        s.assigned += 1;
        const st = (l.stage as string) || "";
        if (st === "closed_won") s.won += 1;
        else if (st === "closed_lost" || st === "churned") s.lost += 1;
        if (!CLOSED_STAGES.includes(st)) s.open += 1;
      }
      for (const lg of logs || []) {
        const owner = leadOwner[lg.lead_id as string];
        const s = owner && stat[owner]; if (!s) continue;
        if ((lg.contact_type as string) === "call") {
          s.calls += 1;
          if ((lg.outcome as string) !== "no_answer") s.answered += 1;
        }
      }

      const list = (reps || []).map((r: Record<string, unknown>) => {
        const s = stat[r.user_id as string] || { assigned: 0, open: 0, won: 0, lost: 0, calls: 0, answered: 0 };
        const decided = s.won + s.lost;
        return {
          ...r,
          assigned: s.assigned,
          open: s.open,
          won: s.won,
          calls: s.calls,
          pickup_rate: s.calls ? Math.round((s.answered / s.calls) * 100) : null,
          close_rate: decided ? Math.round((s.won / decided) * 100) : null,
        };
      });
      return json({ reps: list });
    }

    // ── create_rep ───────────────────────────────────────────────────────────
    if (action === "create_rep") {
      const email = String((body as { email?: string }).email || "").trim().toLowerCase();
      const password = String((body as { password?: string }).password || "");
      const name = String((body as { name?: string }).name || "").trim();
      if (!email || !password) return json({ error: "Email and password are required" }, 400);
      if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { account_type: "sales_rep" },
        user_metadata: { name },
      });
      if (cErr || !created?.user) return json({ error: cErr?.message || "Could not create user" }, 400);

      const { error: rErr } = await admin.from("sales_reps").insert({
        user_id: created.user.id, email, name: name || null, active: true,
      });
      if (rErr) return json({ error: rErr.message }, 500);
      return json({ ok: true, user_id: created.user.id });
    }

    // ── set_password ─────────────────────────────────────────────────────────
    if (action === "set_password") {
      const { user_id } = body as { user_id?: string };
      const password = String((body as { password?: string }).password || "");
      if (!user_id || !password) return json({ error: "user_id and password are required" }, 400);
      if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { error } = await admin.auth.admin.updateUserById(user_id, { password });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── set_active ───────────────────────────────────────────────────────────
    if (action === "set_active") {
      const { user_id, active } = body as { user_id?: string; active?: boolean };
      if (!user_id) return json({ error: "user_id is required" }, 400);
      const on = active === true;
      const { error: uErr } = await admin
        .from("sales_reps").update({ active: on }).eq("user_id", user_id);
      if (uErr) return json({ error: uErr.message }, 500);
      // Block / restore login.
      await admin.auth.admin.updateUserById(user_id, { ban_duration: on ? "none" : "876000h" });
      // Deactivating frees their open leads back to the pool.
      if (!on) {
        await admin.from("leads").update({ owner_id: null })
          .eq("owner_id", user_id).not("stage", "in", `(${CLOSED_STAGES.join(",")})`);
      }
      return json({ ok: true });
    }

    // ── delete_rep ───────────────────────────────────────────────────────────
    if (action === "delete_rep") {
      const { user_id } = body as { user_id?: string };
      if (!user_id) return json({ error: "user_id is required" }, 400);
      // Free their leads first so nothing is orphaned.
      await admin.from("leads").update({ owner_id: null }).eq("owner_id", user_id);
      await admin.from("sales_reps").delete().eq("user_id", user_id);
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── get_config ───────────────────────────────────────────────────────────
    if (action === "get_config") {
      const { data } = await admin
        .from("sales_rep_config").select("auto_assign_enabled, auto_assign_rep_id").eq("id", 1).maybeSingle();
      return json({
        auto_assign_enabled: data?.auto_assign_enabled === true,
        auto_assign_rep_id: data?.auto_assign_rep_id ?? null,
      });
    }

    // ── set_config ───────────────────────────────────────────────────────────
    if (action === "set_config") {
      const { auto_assign_enabled, auto_assign_rep_id } = body as {
        auto_assign_enabled?: boolean;
        auto_assign_rep_id?: string | null;
      };
      const enabled = auto_assign_enabled === true;
      const repId = auto_assign_rep_id || null;
      const { error } = await admin.from("sales_rep_config").upsert(
        { id: 1, auto_assign_enabled: enabled, auto_assign_rep_id: repId, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      );
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, auto_assign_enabled: enabled, auto_assign_rep_id: repId });
    }

    // ── auto_assign_now ──────────────────────────────────────────────────────
    // Distribute every currently-unassigned, still-open lead.
    // If a fixed rep is configured (and active) they get all of them;
    // otherwise uses the same least-loaded round-robin the trigger uses.
    if (action === "auto_assign_now") {
      const { data: cfg } = await admin
        .from("sales_rep_config").select("auto_assign_rep_id").eq("id", 1).maybeSingle();
      const fixedId: string | null = (cfg as Record<string, unknown>)?.auto_assign_rep_id as string ?? null;

      const { data: pending } = await admin
        .from("leads").select("id").is("owner_id", null)
        .not("stage", "in", `(${CLOSED_STAGES.join(",")})`)
        .order("created_at", { ascending: true });

      let assigned = 0;

      if (fixedId) {
        // Fixed-rep mode: verify they're active, then bulk-assign.
        const { data: rep } = await admin
          .from("sales_reps").select("user_id").eq("user_id", fixedId).eq("active", true).maybeSingle();
        if (!rep) return json({ error: "The configured rep is not active" }, 400);
        for (const lead of pending || []) {
          const { error } = await admin.from("leads").update({ owner_id: fixedId }).eq("id", lead.id);
          if (!error) assigned++;
        }
      } else {
        // Least-loaded mode.
        const { data: reps } = await admin.from("sales_reps").select("user_id").eq("active", true);
        const repIds = (reps || []).map((r: { user_id: string }) => r.user_id);
        if (!repIds.length) return json({ error: "No active reps to assign to" }, 400);

        const { data: load } = await admin
          .from("leads").select("owner_id, stage").in("owner_id", repIds);
        const open: Record<string, number> = {};
        for (const id of repIds) open[id] = 0;
        for (const l of load || []) {
          if (!CLOSED_STAGES.includes((l.stage as string) || "")) open[l.owner_id as string] = (open[l.owner_id as string] || 0) + 1;
        }
        for (const lead of pending || []) {
          let best = repIds[0];
          for (const id of repIds) if (open[id] < open[best]) best = id;
          const { error } = await admin.from("leads").update({ owner_id: best }).eq("id", lead.id);
          if (!error) { open[best] += 1; assigned++; }
        }
      }
      return json({ ok: true, assigned });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("sales-rep-api error:", err);
    return json({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
  }
});
