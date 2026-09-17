/**
 * Admin token comparison.
 *
 * Guards the operational routes - /poll, /flush, /peek, /diag, /status - which
 * are for running the system, not for staff. Staff use a session instead; see
 * the note in api.ts about why a token deliberately carries no identity.
 */

/**
 * Compares in time that does not depend on WHERE the strings differ, so a
 * caller cannot discover the token one character at a time by measuring how
 * long a rejection takes.
 *
 * The length check does return early, which reveals the token's length. That is
 * accepted: length alone does not meaningfully narrow a random token, and the
 * alternative complicates the one function here that must stay obviously
 * correct.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Whether a request may use the admin routes.
 *
 * A short or missing configured token fails closed. Without that, a server
 * started with ADMIN_TOKEN unset would expose /poll and /diag to anyone.
 */
export function isAuthorised(configured: string | undefined, presented: string | null): boolean {
  if (typeof configured !== "string" || configured.length < 20) return false;
  if (presented === null) return false;
  return timingSafeEqual(presented, configured);
}
