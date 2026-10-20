import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set(
  (Deno.env.get("QRN_ALLOWED_ORIGINS") || "")
    .split(",").map((origin) => origin.trim()).filter(Boolean),
);
const projectUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const maxBytes = 3 * 1024 * 1024;

function response(origin: string, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "vary": "Origin",
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-photo-path",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "600",
    },
  });
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return { width, height };
    }
    offset += segmentLength;
  }
  return null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBounded(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  if (!allowedOrigins.has(origin)) return new Response("Forbidden", { status: 403 });
  if (request.method === "OPTIONS") return new Response("ok", {
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-photo-path",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "600",
      "vary": "Origin",
    },
  });
  if (request.method !== "POST") return response(origin, { ok: false, error: "Method not allowed." }, 405);
  if (!projectUrl || !serviceKey) return response(origin, { ok: false, error: "Photo upload is not configured." }, 503);
  if (Number(request.headers.get("content-length") || 0) > maxBytes) return response(origin, { ok: false, error: "Choose a smaller photo." }, 413);
  if (!/^image\/jpeg$/i.test(request.headers.get("content-type") || "")) return response(origin, { ok: false, error: "Upload a square JPEG photo." }, 415);

  const path = request.headers.get("x-photo-path") || "";
  if (!/^profile-submissions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/.test(path)) {
    return response(origin, { ok: false, error: "Invalid photo upload path." }, 400);
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBounded(request.body);
  } catch {
    return response(origin, { ok: false, error: "Could not read the photo." }, 400);
  }
  if (!bytes || bytes.length === 0) return response(origin, { ok: false, error: "Choose a photo under 3 MB after cropping." }, 413);
  const dimensions = jpegDimensions(bytes);
  if (!dimensions || dimensions.width !== 600 || dimensions.height !== 600) {
    return response(origin, { ok: false, error: "The uploaded photo must be a valid 600 × 600 square JPEG." }, 400);
  }

  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const admin = createClient(projectUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: permitted, error: limitError } = await admin.rpc("qrn_consume_photo_upload", {
    _ip_hash: await sha256(`${serviceKey}:${ip}`),
  });
  if (limitError) {
    console.error("Photo upload rate limit failed:", limitError.code);
    return response(origin, { ok: false, error: "Photo upload is temporarily unavailable." }, 503);
  }
  if (!permitted) return response(origin, { ok: false, error: "Too many photo uploads from this network. Try again in an hour." }, 429);

  const { error } = await admin.storage.from("qrn-images").upload(path, new Blob([bytes], { type: "image/jpeg" }), {
    contentType: "image/jpeg",
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) {
    console.error("Profile photo upload failed:", error.message);
    return response(origin, { ok: false, error: "Could not store that photo. Try again or submit without it." }, 400);
  }
  return response(origin, { ok: true, path });
});
