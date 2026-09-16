/**
 * Cross-origin access for the dashboard.
 *
 * The dashboard runs on a different origin from the worker, and it sends an
 * `x-admin-token` header - a custom header, so every request is preceded by a
 * preflight that must be answered.
 *
 * Origins are allow-listed rather than reflected. Reflecting whatever origin
 * asks would let any website a staff member happens to visit make credentialed
 * calls to this API from their browser. The token would still stop it reading
 * anything, but there is no reason to hand out the opportunity, and "it is
 * behind a token" is exactly the reasoning that precedes an incident.
 */
export const ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  // The smoke test runs its own server on 5174.
  "http://127.0.0.1:5174",
  "http://localhost:5174",
] as const;

export function corsHeaders(origin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-admin-token",
    "Access-Control-Max-Age": "600",
    // Caches must not serve one origin's response to another.
    Vary: "Origin",
  };
  if (origin === null) return base;
  const allowed = ALLOWED_ORIGINS.find((candidate) => candidate === origin);
  if (allowed === undefined) return base;
  return { ...base, "Access-Control-Allow-Origin": allowed };
}
