/**
 * Cloudflare Workers feasibility probe for SimpleTickets.
 *
 * Answers the two questions that decide whether Workers can host this system
 * (docs/runtime-feasibility.md gates 2 and 4):
 *
 *   1. Can a Worker open a verified TLS socket to the Zimbra host on 993/465?
 *      Locally both handshake, but Workers blocks some outbound destinations,
 *      and port 25 outright. A local success proves nothing about the runtime.
 *   2. What does secure password verification cost against the 10 ms free CPU
 *      allowance? Per specs/001-email-ticketing/plan.md, hashing is never
 *      weakened to fit a free tier, so this measurement decides the tier.
 *
 * Deliberate limits, per the security notes in docs/runtime-feasibility.md:
 *   - Every route requires a shared secret. Unknown or unauthorised requests
 *     get 404 and learn nothing.
 *   - The host and ports are a fixed allowlist. This is not an open proxy.
 *   - No mailbox is opened, no message is fetched, nothing is sent, and no
 *     mailbox credential is accepted or stored. The TLS probe reads the
 *     server's public greeting banner and hangs up.
 *   - Protocol errors are reported as categories, never raw text.
 *
 * Delete this Worker once the gate is answered.
 */
import { connect } from "cloudflare:sockets";

interface Env {
  PROBE_TOKEN: string;
}

const MAIL_HOST = "mail.allcheckservices.com";
const ALLOWED_PORTS = new Set([993, 465, 587]);
const GREETING_LIMIT = 200;
const SOCKET_TIMEOUT_MS = 10_000;
const MAX_ITERATIONS = 1_000_000;
const DEFAULT_ITERATIONS = 600_000;

/** Constant-time-ish compare, so a wrong token leaks no length or prefix. */
function tokensMatch(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** Never echo a raw protocol error: it can carry command or address detail. */
function errorCategory(error: unknown): string {
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("refused")) return "connection_refused";
  if (text.includes("certificate") || text.includes("tls")) return "tls_failure";
  if (text.includes("proxy") || text.includes("blocked")) return "blocked_by_runtime";
  return "connect_failed";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readGreeting(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("read timeout"));
      }, timeoutMs);
    });
    const chunk = await Promise.race([reader.read(), expiry]);
    if (chunk.done || chunk.value === undefined) return "";
    return new TextDecoder().decode(chunk.value).slice(0, GREETING_LIMIT).trim();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

/**
 * Open a verified TLS connection, read the public banner, close. Proves the
 * runtime can reach the endpoint; proves nothing about authentication.
 */
async function probeTls(port: number): Promise<Response> {
  const started = Date.now();
  let socket;
  try {
    socket = connect(
      { hostname: MAIL_HOST, port },
      { secureTransport: "on", allowHalfOpen: false },
    );
    const greeting = await readGreeting(socket.readable, SOCKET_TIMEOUT_MS);
    return json({
      probe: "tls",
      host: MAIL_HOST,
      port,
      reachable: true,
      greetingPrefix: greeting.slice(0, 80),
      wallMs: Date.now() - started,
      note: "TLS reachability only. No authentication, no mailbox access, nothing sent.",
    });
  } catch (error) {
    return json({
      probe: "tls",
      host: MAIL_HOST,
      port,
      reachable: false,
      category: errorCategory(error),
      wallMs: Date.now() - started,
    });
  } finally {
    if (socket !== undefined) {
      try {
        await socket.close();
      } catch {
        // Already closed or never established; nothing useful to report.
      }
    }
  }
}

/**
 * Derive one PBKDF2 hash with a synthetic password, to size secure password
 * verification against the CPU allowance.
 *
 * Workers freezes the clock between I/O operations as a side-channel defence,
 * so wallMs here is expected to read 0 and is NOT the measurement. Read actual
 * CPU from `wrangler tail`, which reports cpuTime per invocation.
 */
async function probeHash(iterations: number): Promise<Response> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("synthetic-benchmark-password-not-a-real-secret"),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const started = Date.now();
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return json({
    probe: "hash",
    algorithm: "PBKDF2-HMAC-SHA256",
    iterations,
    derivedBytes: bits.byteLength,
    wallMs: Date.now() - started,
    note: "wallMs is unreliable: Workers freezes the clock between I/O. Read cpuTime from `wrangler tail`.",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const notFound = new Response("Not found", { status: 404 });

    const expected = env.PROBE_TOKEN;
    if (typeof expected !== "string" || expected.length < 20) {
      return json(
        { error: "PROBE_TOKEN is unset or too short. Set it with: wrangler secret put PROBE_TOKEN" },
        503,
      );
    }
    const given = request.headers.get("x-probe-token");
    if (given === null || !tokensMatch(given, expected)) return notFound;

    const url = new URL(request.url);
    if (url.pathname === "/tls") {
      const port = Number(url.searchParams.get("port") ?? "993");
      if (!ALLOWED_PORTS.has(port)) {
        return json({ error: "port not in allowlist", allowed: [...ALLOWED_PORTS] }, 400);
      }
      return probeTls(port);
    }
    if (url.pathname === "/hash") {
      const raw = Number(url.searchParams.get("iterations") ?? String(DEFAULT_ITERATIONS));
      if (!Number.isInteger(raw) || raw < 1 || raw > MAX_ITERATIONS) {
        return json({ error: `iterations must be an integer in 1..${String(MAX_ITERATIONS)}` }, 400);
      }
      return probeHash(raw);
    }
    return notFound;
  },
} satisfies ExportedHandler<Env>;
