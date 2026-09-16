/**
 * Resend inbound-email webhook receiver.
 *
 * This is the trust boundary for the whole system: everything downstream treats
 * what arrives here as a real employee email. An unauthenticated endpoint would
 * let anyone forge tickets, so an unverified request is rejected before its body
 * is parsed or looked at.
 *
 * Deliberately runtime-agnostic — a standard fetch handler and WebCrypto only,
 * with no Cloudflare-specific APIs — because the hosting decision is not final
 * (docs/stack-validation.md). It runs unchanged on Workers, Deno, Bun or Node.
 *
 * Current scope: verify, then record the SHAPE of the payload (which fields
 * exist, how big they are) so the ingestion model in T010/T011 is built against
 * a real message rather than a guess. Message content is deliberately not
 * logged: the constitution requires sensitive mail content to stay out of logs,
 * and this endpoint has no storage yet.
 */

interface Env {
  RESEND_WEBHOOK_SECRET: string;
}

/** Reject replayed deliveries: Svix recommends a five-minute tolerance. */
const TIMESTAMP_TOLERANCE_SECONDS = 300;
/** Bound the body before parsing, so a huge post cannot exhaust memory. */
const MAX_BODY_BYTES = 30 * 1024 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Svix secrets are `whsec_` followed by base64. Some providers hand out a raw
 * string instead, and a secret that fails to decode must never crash the
 * endpoint — a 500 here would both lose the delivery and leak that something
 * is misconfigured. Fall back to raw UTF-8 bytes and report which path was
 * taken, without ever logging the secret itself.
 */
function secretToKeyBytes(secret: string): { bytes: Uint8Array; encoding: string } {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, encoding: "base64" };
  } catch {
    return { bytes: new TextEncoder().encode(raw), encoding: "raw-utf8" };
  }
}

function bytesToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Svix signature scheme: HMAC-SHA256 over `{id}.{timestamp}.{body}`, keyed with
 * the base64 secret after its `whsec_` prefix. The header may carry several
 * space-separated `v1,<signature>` values during key rotation, so any match is
 * accepted.
 */
async function signatureIsValid(
  secret: string,
  id: string,
  timestamp: string,
  header: string,
  body: string,
): Promise<boolean> {
  const { bytes, encoding } = secretToKeyBytes(secret);
  if (encoding !== "base64") {
    // Diagnostic only: length and prefix shape, never the value.
    console.warn(
      `Signing secret is not base64 after its prefix (length ${String(secret.length)}, whsec_ prefix: ${String(secret.startsWith("whsec_"))}). Falling back to raw bytes.`,
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const expected = bytesToBase64(signed);
  for (const candidate of header.split(" ")) {
    const [version, value] = candidate.split(",");
    if (version === "v1" && value !== undefined && timingSafeEqual(value, expected)) {
      return true;
    }
  }
  return false;
}

/** Field names and sizes only — never the message content itself. */
function describeShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return { array: value.length, of: value.length > 0 ? describeShape(value[0], depth + 1) : "empty" };
  }
  if (typeof value === "object") {
    if (depth > 2) return "object";
    const shape: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) shape[key] = describeShape(child, depth + 1);
    return shape;
  }
  if (typeof value === "string") return `string(${String(value.length)})`;
  return typeof value;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const secret = env.RESEND_WEBHOOK_SECRET;
    if (typeof secret !== "string" || secret.length === 0) {
      console.error("RESEND_WEBHOOK_SECRET is not set; refusing to accept deliveries.");
      return new Response("Not configured", { status: 503 });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_BODY_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }

    const id = request.headers.get("svix-id");
    const timestamp = request.headers.get("svix-timestamp");
    const signature = request.headers.get("svix-signature");
    if (id === null || timestamp === null || signature === null) {
      return new Response("Unsigned", { status: 401 });
    }

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SECONDS) {
      return new Response("Stale or invalid timestamp", { status: 401 });
    }

    // Read as text, not JSON: the signature covers the exact bytes sent.
    const body = await request.text();
    let verified = false;
    try {
      verified = await signatureIsValid(secret, id, timestamp, signature, body);
    } catch (error) {
      console.error(
        `Signature verification failed to run: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return new Response("Unauthorized", { status: 401 });
    }
    if (!verified) {
      return new Response("Bad signature", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      console.error("Signed delivery was not valid JSON.");
      return new Response("Bad request", { status: 400 });
    }

    // Structure and sizes only. Addresses and message text stay out of logs.
    const event =
      typeof payload === "object" && payload !== null && "type" in payload
        ? String((payload as { type: unknown }).type)
        : "unknown";
    console.log(
      JSON.stringify({
        accepted: true,
        svixId: id,
        event,
        bodyBytes: body.length,
        shape: describeShape(payload),
      }),
    );

    // 2xx tells Svix the delivery succeeded and stops it retrying.
    return new Response("OK", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
