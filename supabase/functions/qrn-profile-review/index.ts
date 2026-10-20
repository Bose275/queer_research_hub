import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set(
  (Deno.env.get("QRN_ALLOWED_ORIGINS") || "")
    .split(",").map((origin) => origin.trim()).filter(Boolean),
);
const adminIds = new Set(
  (Deno.env.get("QRN_ADMIN_USER_IDS") || "")
    .split(",").map((id) => id.trim().toLowerCase())
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)),
);
const projectUrl = Deno.env.get("SUPABASE_URL") || "";
function defaultKeySet(variable: string): string {
  try {
    const value = Deno.env.get(variable);
    if (!value) return "";
    const keys: unknown = JSON.parse(value);
    if (keys && typeof keys === "object" && !Array.isArray(keys) &&
        typeof (keys as Record<string, unknown>).default === "string") {
      return (keys as Record<string, string>).default;
    }
  } catch { /* Older projects may not define key-set variables. */ }
  return "";
}
const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") || defaultKeySet("SUPABASE_PUBLISHABLE_KEYS");
const secretKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || defaultKeySet("SUPABASE_SECRET_KEYS");
const columns = "id,display_name,pronouns,role_type,title,institution,faculty,department,bio,website_url,orcid_url,linkedin_url,photo_path,photo_consent,submitter_email,suggested_tags,consent_to_publish,status,submitted_at";

function reply(origin: string, body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "vary": "Origin",
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-retry-count, traceparent, tracestate, baggage",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}
function fail(origin: string, message: string, code = 400): Response {
  return reply(origin, { ok: false, error: message }, code);
}

Deno.serve(async (request) => {
  const originHeader = request.headers.get("origin") || "";
  // Never reflect an untrusted origin. CORS adds browser protection; Auth and
  // the server-side allowlist below are the actual authorization checks.
  if (!allowedOrigins.has(originHeader)) return new Response("Forbidden", { status: 403 });
  if (request.method === "OPTIONS") return new Response("ok", {
    headers: {
      "access-control-allow-origin": originHeader,
      "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-retry-count, traceparent, tracestate, baggage",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "600",
      "vary": "Origin",
    },
  });
  if (request.method !== "POST") return fail(originHeader, "Method not allowed.", 405);
  if (!projectUrl || !publishableKey || !secretKey || !adminIds.size) {
    console.error("Profile review is missing server configuration.");
    return fail(originHeader, "The review service is not configured.", 503);
  }

  const authorization = request.headers.get("authorization") || "";
  const token = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) return fail(originHeader, "Sign in to continue.", 401);

  // Verify the user token with Supabase Auth. Never authorize by trusting the
  // email, a client flag, or a JWT payload decoded without signature checking.
  const authClient = createClient(projectUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const [{ data: userData, error: userError }, { data: claimsData, error: claimsError }] = await Promise.all([
    authClient.auth.getUser(token),
    authClient.auth.getClaims(token),
  ]);
  if (userError || claimsError || !userData.user || !claimsData?.claims) return fail(originHeader, "Your sign-in has expired. Sign in again.", 401);
  if (!adminIds.has(userData.user.id.toLowerCase())) return fail(originHeader, "You are not authorized to review profiles.", 403);

  // The elevated key is only used inside this server function. Its endpoint is
  // constrained to a read-only queue view and a narrow, audited decision RPC.
  const db = createClient(projectUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 16_384) return fail(originHeader, "Request is too large.", 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad body");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(originHeader, "Request body must be a JSON object.");
  }

  if (body.op === "list") {
    const { data, error } = await db.from("profile_submissions")
      .select(columns).in("status", ["pending", "reviewing"])
      .order("submitted_at", { ascending: true }).limit(100);
    if (error) {
      console.error("Could not read profile queue:", error.code);
      return fail(originHeader, "Could not load the review queue.", 500);
    }
    const rows = data || [];
    const paths = rows.map((item) => item.photo_path).filter((path): path is string => typeof path === "string");
    const signed = paths.length ? await db.storage.from("qrn-images").createSignedUrls(paths, 600) : { data: [], error: null };
    if (signed.error) console.error("Could not create reviewer photo links:", signed.error.message);
    const previews = new Map((signed.data || []).filter((item) => item.path && item.signedUrl).map((item) => [item.path, item.signedUrl]));
    return reply(originHeader, {
      ok: true,
      submissions: rows.map((item) => ({
        ...item,
        photo_preview_url: item.photo_path ? previews.get(item.photo_path) || null : null,
      })),
    });
  }

  if (body.op !== "review") return fail(originHeader, "Unknown action.");
  const id = typeof body.submission_id === "string" ? body.submission_id : "";
  const action = body.action;
  const slug = body.profile_slug;
  const note = body.admin_notes;
  const tags = body.approved_tags;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return fail(originHeader, "Invalid submission ID.");
  }
  if (!["approve", "needs_changes", "rejected"].includes(String(action))) return fail(originHeader, "Invalid review decision.");
  if (note !== null && note !== undefined && (typeof note !== "string" || note.length > 1000)) return fail(originHeader, "Reviewer notes must be 1,000 characters or fewer.");
  if (action === "approve") {
    if (typeof slug !== "string" || slug.length > 150 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return fail(originHeader, "Enter a valid unique lowercase profile slug.");
    if (tags !== null && tags !== undefined && (!Array.isArray(tags) || tags.length > 20 || tags.some((tag) => typeof tag !== "string" || tag.length > 80))) return fail(originHeader, "Choose no more than 20 valid tags.");
  }

  const { data, error } = await db.rpc("qrn_admin_review_action", {
    _submission_id: id,
    _action: action,
    _profile_slug: action === "approve" ? slug : null,
    _approved_tags: action === "approve" ? tags : null,
    _admin_notes: note || null,
    _reviewer_id: userData.user.id,
  });
  if (error) {
    console.error("Profile review decision failed:", error.code);
    const message = error.code === "23505"
      ? "That profile slug is already in use. Choose another slug."
      : error.code === "22023" || error.code === "P0001"
        ? error.message
        : "Could not save this review decision.";
    return fail(originHeader, message, 400);
  }
  return reply(originHeader, {
    ok: true,
    person_id: data && typeof data === "object" ? data.person_id || null : null,
  });
});
