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
//   auto_assign_now  → assign every currently-unassigned lead using the
//                      configured mode (least-loaded / fixed rep / round robin)
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

// The round-robin pool holds rep user_ids plus this sentinel for the main
// QuoteLeads account. A house turn leaves the lead unassigned, which under RLS
// means only the admin can see it — no rep login is involved.
const HOUSE = "house";
const HOUSE_EMAIL = "contact@quoteleads.com.au";
const MODES = ["least_busy", "fixed", "round_robin"];

// Keep a rep out of the saved rotation once they are disabled or deleted.
// deno-lint-ignore no-explicit-any
async function dropFromPool(admin: any, userId: string) {
  const { data } = await admin
    .from("sales_rep_config").select("round_robin_pool").eq("id", 1).maybeSingle();
  const pool: string[] = (data?.round_robin_pool as string[]) || [];
  if (!pool.includes(userId)) return;
  await admin.from("sales_rep_config")
    .update({ round_robin_pool: pool.filter((e) => e !== userId), updated_at: new Date().toISOString() })
    .eq("id", 1);
}

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
        .select("user_id, email, name, active, reply_to_email, created_at")
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

      const replyTo = String((body as { reply_to_email?: string }).reply_to_email || "").trim().toLowerCase();
      const { error: rErr } = await admin.from("sales_reps").insert({
        user_id: created.user.id, email, name: name || null, active: true,
        reply_to_email: replyTo || null,
      });
      if (rErr) return json({ error: rErr.message }, 500);
      return json({ ok: true, user_id: created.user.id });
    }

    // ── update_rep ───────────────────────────────────────────────────────────
    // Display name and the Reply-To used on sales emails this rep sends.
    // Blank reply_to_email clears the override and falls back to their login
    // address, which is what send-sales-email does when the column is null.
    if (action === "update_rep") {
      const { user_id } = body as { user_id?: string };
      if (!user_id) return json({ error: "user_id is required" }, 400);
      const name = String((body as { name?: string }).name ?? "").trim();
      const replyTo = String((body as { reply_to_email?: string }).reply_to_email ?? "").trim().toLowerCase();
      if (replyTo && !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(replyTo)) {
        return json({ error: "Enter a valid reply-to email" }, 400);
      }
      const { error } = await admin.from("sales_reps")
        .update({ name: name || null, reply_to_email: replyTo || null })
        .eq("user_id", user_id);
      if (error) return json({ error: error.message }, 500);
      if (name) await admin.auth.admin.updateUserById(user_id, { user_metadata: { name } });
      return json({ ok: true });
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
      // Deactivating frees their open leads back to the pool, and takes them
      // out of the round-robin rotation so the turn order stays honest.
      if (!on) {
        await admin.from("leads").update({ owner_id: null })
          .eq("owner_id", user_id).not("stage", "in", `(${CLOSED_STAGES.join(",")})`);
        await dropFromPool(admin, user_id);
      }
      return json({ ok: true });
    }

    // ── delete_rep ───────────────────────────────────────────────────────────
    if (action === "delete_rep") {
      const { user_id } = body as { user_id?: string };
      if (!user_id) return json({ error: "user_id is required" }, 400);
      // Free their leads first so nothing is orphaned.
      await admin.from("leads").update({ owner_id: null }).eq("owner_id", user_id);
      await dropFromPool(admin, user_id);
      await admin.from("sales_reps").delete().eq("user_id", user_id);
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── get_config ───────────────────────────────────────────────────────────
    if (action === "get_config") {
      const { data } = await admin
        .from("sales_rep_config")
        .select("auto_assign_enabled, auto_assign_rep_id, auto_assign_mode, round_robin_pool, house_email")
        .eq("id", 1).maybeSingle();
      return json({
        auto_assign_enabled: data?.auto_assign_enabled === true,
        auto_assign_rep_id: data?.auto_assign_rep_id ?? null,
        auto_assign_mode: (data?.auto_assign_mode as string) || "least_busy",
        round_robin_pool: (data?.round_robin_pool as string[]) ?? [],
        house_email: (data?.house_email as string) || HOUSE_EMAIL,
      });
    }

    // ── set_config ───────────────────────────────────────────────────────────
    if (action === "set_config") {
      const { auto_assign_enabled, auto_assign_rep_id, auto_assign_mode, round_robin_pool } = body as {
        auto_assign_enabled?: boolean;
        auto_assign_rep_id?: string | null;
        auto_assign_mode?: string;
        round_robin_pool?: string[];
      };
      const enabled = auto_assign_enabled === true;
      const mode = MODES.includes(String(auto_assign_mode)) ? String(auto_assign_mode) : "least_busy";
      const repId = mode === "fixed" ? (auto_assign_rep_id || null) : null;

      // Only keep pool entries we recognise: the house slot, or a real rep.
      let pool: string[] = [];
      if (Array.isArray(round_robin_pool) && round_robin_pool.length) {
        const { data: reps } = await admin.from("sales_reps").select("user_id");
        const known = new Set((reps || []).map((r: { user_id: string }) => r.user_id));
        const seen = new Set<string>();
        for (const raw of round_robin_pool) {
          const entry = String(raw);
          if (seen.has(entry)) continue;
          if (entry === HOUSE || known.has(entry)) { pool.push(entry); seen.add(entry); }
        }
      }
      if (mode === "round_robin" && enabled && !pool.length) {
        return json({ error: "Pick at least one rep (or the main account) for the round-robin pool" }, 400);
      }
      if (mode === "fixed" && enabled && !repId) {
        return json({ error: "Pick the rep that new leads should go to" }, 400);
      }

      const { error } = await admin.from("sales_rep_config").upsert(
        {
          id: 1,
          auto_assign_enabled: enabled,
          auto_assign_rep_id: repId,
          auto_assign_mode: mode,
          round_robin_pool: pool,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      if (error) return json({ error: error.message }, 500);
      return json({
        ok: true,
        auto_assign_enabled: enabled,
        auto_assign_rep_id: repId,
        auto_assign_mode: mode,
        round_robin_pool: pool,
      });
    }

    // ── auto_assign_now ──────────────────────────────────────────────────────
    // Distribute every currently-unassigned, still-open lead using the
    // configured mode: a fixed rep takes all of them, round robin deals them
    // out one at a time across the pool, and least-busy fills the lightest
    // load first. Round-robin 'house' turns are skipped — those leads stay
    // unassigned on purpose, which keeps them admin-only.
    if (action === "auto_assign_now") {
      const { data: cfg } = await admin
        .from("sales_rep_config")
        .select("auto_assign_rep_id, auto_assign_mode, round_robin_pool, round_robin_cursor")
        .eq("id", 1).maybeSingle();
      const c = (cfg || {}) as Record<string, unknown>;
      const mode = (c.auto_assign_mode as string) || "least_busy";
      const fixedId: string | null = mode === "fixed" ? ((c.auto_assign_rep_id as string) ?? null) : null;

      const { data: pending } = await admin
        .from("leads").select("id").is("owner_id", null)
        .not("stage", "in", `(${CLOSED_STAGES.join(",")})`)
        .order("created_at", { ascending: true });

      let assigned = 0;

      if (mode === "round_robin") {
        // Same filter the trigger applies: house stays, dead/inactive reps go.
        const { data: reps } = await admin.from("sales_reps").select("user_id").eq("active", true);
        const live = new Set((reps || []).map((r: { user_id: string }) => r.user_id));
        const pool = ((c.round_robin_pool as string[]) || [])
          .filter((e) => e === HOUSE || live.has(e));
        if (!pool.length) return json({ error: "Nobody is in the round-robin pool" }, 400);

        let cursor = Number(c.round_robin_cursor ?? 0);
        let house = 0;
        for (const lead of pending || []) {
          cursor += 1;
          const pick = pool[cursor % pool.length];
          if (pick === HOUSE) { house++; continue; }   // left with the main account
          const { error } = await admin.from("leads").update({ owner_id: pick }).eq("id", lead.id);
          if (!error) assigned++;
        }
        await admin.from("sales_rep_config")
          .update({ round_robin_cursor: cursor, updated_at: new Date().toISOString() }).eq("id", 1);
        return json({ ok: true, assigned, house });
      }

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
