import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set((Deno.env.get("QRN_ALLOWED_ORIGINS") || "").split(",").map(s => s.trim()).filter(Boolean));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const adminIds = new Set((Deno.env.get("QRN_ADMIN_USER_IDS") || "").split(",").map(s => s.trim().toLowerCase()).filter(s => uuid.test(s)));
function defaultKey(variable: string): string {
  try { const value = JSON.parse(Deno.env.get(variable) || "{}"); return typeof value.default === "string" ? value.default : ""; } catch { return ""; }
}
const projectUrl = Deno.env.get("SUPABASE_URL") || "";
const publicKey = Deno.env.get("SUPABASE_ANON_KEY") || defaultKey("SUPABASE_PUBLISHABLE_KEYS");
const secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || defaultKey("SUPABASE_SECRET_KEYS");
const options = { auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false } };
const columns = "id,title,project_type,institution,researcher_names,short_description,description,website_url,image_url,image_consent,suggested_tags,submitter_name,submitter_email,consent_to_publish,status,submitted_at,admin_notes";
const allowedHeaders = "authorization, apikey, content-type, x-client-info, x-retry-count, traceparent, tracestate, baggage";
function reply(origin: string, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type":"application/json; charset=utf-8", "cache-control":"no-store", "vary":"Origin",
    "access-control-allow-origin":origin, "access-control-allow-headers":allowedHeaders,
    "access-control-allow-methods":"POST, OPTIONS"
  } });
}
function fail(origin: string, error: string, status = 400) { return reply(origin, { ok:false, error }, status); }

Deno.serve(async request => {
  const origin = request.headers.get("origin") || "";
  if (!allowedOrigins.has(origin)) return new Response("Forbidden", { status:403 });
  if (request.method === "OPTIONS") return new Response("ok", { headers: {
    "access-control-allow-origin":origin, "access-control-allow-headers":allowedHeaders,
    "access-control-allow-methods":"POST, OPTIONS", "access-control-max-age":"600", "vary":"Origin"
  } });
  if (request.method !== "POST") return fail(origin, "Method not allowed.", 405);
  if (!projectUrl || !publicKey || !secretKey || !adminIds.size) return fail(origin, "Research review is missing its server configuration.", 503);
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return fail(origin, "Sign in to review research.", 401);
  try {
    // Verify with Auth; never trust a decoded JWT or a client-supplied reviewer ID.
    const auth = createClient(projectUrl, publicKey, options);
    const { data: userData, error: userError } = await auth.auth.getUser(token);
    if (userError || !userData.user) return fail(origin, "Your sign-in has expired. Sign in again.", 401);
    if (!adminIds.has(userData.user.id.toLowerCase())) return fail(origin, "This account is not authorized to review research.", 403);
    let body: Record<string, unknown>;
    try {
      const raw = await request.text(); if (raw.length > 16384) return fail(origin, "Request is too large.", 413);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed;
    } catch { return fail(origin, "Send a JSON object."); }
    const db = createClient(projectUrl, secretKey, options);
    if (body.op === "list") {
      const queueStatus = body.status ?? "pending", offset = body.offset ?? 0;
      if (typeof queueStatus !== "string" || !["pending", "needs_changes"].includes(queueStatus) || typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 100000) return fail(origin, "Invalid queue filter or offset.");
      const { data: rows, error } = await db.from("research_submissions").select(columns)
        .eq("status", queueStatus).order("submitted_at", { ascending:true }).order("id", { ascending:true }).range(offset, offset + 100);
      if (error) { console.error("Research queue failed:", error.code); return fail(origin, "Could not load research_submissions. Run research-review.sql after the submission setup.", 500); }
      const people: Array<{ id:string; display_name:string; institution:string | null }> = [];
      for (let start = 0; ; start += 500) {
        const { data, error: peopleError } = await db.from("people").select("id,display_name,institution")
          .eq("status", "published").order("display_name").order("id").range(start, start + 499);
        if (peopleError) return fail(origin, "Could not load researcher profiles.", 500);
        people.push(...(data || [])); if (!data || data.length < 500) break;
      }
      return reply(origin, { ok:true, submissions:(rows || []).slice(0,100), has_more:(rows || []).length > 100, people });
    }
    if (body.op !== "review") return fail(origin, "Unknown action.");
    if (typeof body.submission_id !== "string" || !uuid.test(body.submission_id)) return fail(origin, "Invalid submission ID.");
    if (typeof body.action !== "string" || !["approve", "needs_changes", "rejected"].includes(body.action)) return fail(origin, "Invalid review decision.");
    if (body.admin_notes !== null && body.admin_notes !== undefined && (typeof body.admin_notes !== "string" || [...body.admin_notes].length > 1000)) return fail(origin, "Reviewer notes must be 1,000 characters or fewer.");
    if (body.action === "needs_changes" && (typeof body.admin_notes !== "string" || !body.admin_notes.trim())) return fail(origin, "Describe the requested changes in a private note.");
    const approve = body.action === "approve";
    if (approve) {
      if (typeof body.project_slug !== "string" || body.project_slug.length > 150 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(body.project_slug)) return fail(origin, "Enter a valid lowercase project slug.");
      if (!Array.isArray(body.approved_tags) || body.approved_tags.length > 20 || body.approved_tags.some(t => typeof t !== "string" || [...t.trim()].length < 1 || [...t.trim()].length > 80)) return fail(origin, "Choose up to 20 topics, 80 characters each.");
      if (!Array.isArray(body.approved_people) || body.approved_people.length > 20 || body.approved_people.some(id => typeof id !== "string" || !uuid.test(id))) return fail(origin, "Choose up to 20 valid researcher profiles.");
    }
    const { data, error } = await db.rpc("qrn_admin_review_research", {
      _submission_id:body.submission_id, _action:body.action,
      _project_slug:approve ? body.project_slug : null,
      _approved_tags:approve ? body.approved_tags : [],
      _approved_people:approve ? body.approved_people : [],
      _admin_notes:body.admin_notes || null, _reviewer_id:userData.user.id
    });
    if (error) {
      console.error("Research review failed:", error.code);
      const message = error.code === "23505" ? "That project slug is already in use. Choose another slug."
        : ["22023", "P0001"].includes(error.code) ? error.message
        : "Could not save the review decision. Confirm research-review.sql has been run; check Edge Function logs.";
      return fail(origin, message);
    }
    return reply(origin, { ok:true, project_id:data?.project_id || null, already_reviewed:!!data?.already_reviewed });
  } catch {
    return fail(origin, "Research review is temporarily unavailable. Refresh the queue before retrying a decision.", 500);
  }
});
