// =====================================================================
// OCC Ops Dashboard - "admin-users" Supabase Edge Function
// =====================================================================
// Lets an ADMIN create staff accounts and change their role / AOC /
// active status / password from the dashboard's Admin tab. This runs on
// Supabase's servers with the secret service-role key (never sent to the
// browser), and checks on every call that the caller is a logged-in,
// active admin.
//
// Secrets it uses (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase automatically):
//   ALLOWED_ORIGIN         e.g. https://yourname.github.io   (recommended)
//   USERNAME_EMAIL_DOMAIN  must match USERNAME_EMAIL_DOMAIN in js/config.js
//                          (default: occ-dashboard.invalid)
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const EMAIL_DOMAIN = Deno.env.get("USERNAME_EMAIL_DOMAIN") || "occ-dashboard.invalid";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ROLES = ["shift_user", "duty_manager", "admin"];
const BAN_FOREVER = "876000h"; // ~100 years

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGIN === "*" ? "*" : (origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  // --- Who is calling? Must be a logged-in, active admin. ---
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json(req, 401, { error: "Not authenticated" });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Validates the caller's login token with Supabase Auth.
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json(req, 401, { error: "Not authenticated" });
  const callerId = userData.user.id;

  const { data: caller } = await admin
    .from("profiles").select("role, active").eq("id", callerId).maybeSingle();
  if (!caller || !caller.active || caller.role !== "admin") {
    return json(req, 403, { error: "Insufficient permissions" });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, 400, { error: "Invalid JSON" }); }

  const { data: aocRows } = await admin.from("aocs").select("code");
  const aocCodes = (aocRows || []).map((a: { code: string }) => a.code);

  // ---------------- create ----------------
  if (body.action === "create") {
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();
    const role = String(body.role || "");
    const aoc = body.aoc ? String(body.aoc) : null;

    if (!username || !password || !fullName || !role) {
      return json(req, 400, { error: "username, password, full_name and role are required" });
    }
    if (!/^[a-z0-9._-]{2,40}$/.test(username)) {
      return json(req, 400, { error: "Username must be 2-40 characters: letters, numbers, dot, dash or underscore" });
    }
    if (password.length < 8) return json(req, 400, { error: "Password must be at least 8 characters" });
    if (!ROLES.includes(role)) return json(req, 400, { error: `role must be one of ${ROLES.join(", ")}` });
    if (aoc && !aocCodes.includes(aoc)) return json(req, 400, { error: "Unknown AOC code" });

    const { data: clash } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
    if (clash) return json(req, 409, { error: "Username already exists" });

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: `${username}@${EMAIL_DOMAIN}`,
      password,
      email_confirm: true,
      user_metadata: { username, full_name: fullName },
    });
    if (createErr || !created?.user) {
      const msg = createErr?.message || "Could not create user";
      const status = /already|registered|exists/i.test(msg) ? 409 : 400;
      return json(req, status, { error: status === 409 ? "Username already exists" : msg });
    }

    // The database trigger created an inactive profile; activate it.
    const { error: profErr } = await admin.from("profiles")
      .update({ username, full_name: fullName, role, aoc, active: true })
      .eq("id", created.user.id);
    if (profErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      return json(req, 400, { error: profErr.message });
    }
    return json(req, 201, { id: created.user.id });
  }

  // ---------------- update ----------------
  if (body.action === "update") {
    const id = String(body.id || "");
    if (!id) return json(req, 400, { error: "id is required" });
    const { data: target } = await admin.from("profiles").select("id").eq("id", id).maybeSingle();
    if (!target) return json(req, 404, { error: "Not found" });

    const updates: Record<string, unknown> = {};
    if (body.active !== undefined) updates.active = !!body.active;
    if (body.role !== undefined) {
      if (!ROLES.includes(String(body.role))) return json(req, 400, { error: `role must be one of ${ROLES.join(", ")}` });
      updates.role = body.role;
    }
    if (body.aoc !== undefined) {
      const aoc = body.aoc ? String(body.aoc) : null;
      if (aoc && !aocCodes.includes(aoc)) return json(req, 400, { error: "Unknown AOC code" });
      updates.aoc = aoc;
    }
    const password = body.password ? String(body.password) : "";
    if (password && password.length < 8) return json(req, 400, { error: "Password must be at least 8 characters" });
    if (!Object.keys(updates).length && !password) return json(req, 400, { error: "Nothing to update" });

    // Safety net: an admin can't lock themselves out.
    if (id === callerId && (updates.active === false || (updates.role && updates.role !== "admin"))) {
      return json(req, 400, { error: "You can't deactivate or demote your own account" });
    }

    if (Object.keys(updates).length) {
      const { error } = await admin.from("profiles").update(updates).eq("id", id);
      if (error) return json(req, 400, { error: error.message });
    }
    const authUpdates: Record<string, unknown> = {};
    if (password) authUpdates.password = password;
    if (updates.active === false) authUpdates.ban_duration = BAN_FOREVER;
    if (updates.active === true) authUpdates.ban_duration = "none";
    if (Object.keys(authUpdates).length) {
      const { error } = await admin.auth.admin.updateUserById(id, authUpdates);
      if (error) return json(req, 400, { error: error.message });
    }
    // A deactivated user is blocked immediately by the database rules
    // (profiles.active = false) and the ban stops them logging in again.
    return json(req, 200, { ok: true });
  }

  return json(req, 400, { error: "Unknown action" });
});
