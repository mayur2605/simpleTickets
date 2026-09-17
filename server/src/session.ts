/**
 * Staff sessions (R06).
 *
 * Pure except for crypto: no storage, no clock of its own.
 *
 * Two decisions carry most of the security here.
 *
 * The cookie is HttpOnly, Secure and SameSite=Strict. HttpOnly keeps it out of
 * reach of any script on the page, so an XSS cannot simply read a staff
 * session; SameSite=Strict is the CSRF defence, because another site cannot
 * make the browser attach this cookie to a request it forges.
 *
 * The token is stored HASHED, for the same reason passwords are. Anyone who
 * reads the sessions table - a backup, a stray query, a leaked export - must not
 * come away with something they can log in with. SHA-256 is enough here and
 * PBKDF2 is not needed: unlike a password, the token is 256 bits of randomness
 * we generated, so there is nothing to brute force.
 */

const COOKIE_NAME = "st_session";
export const SESSION_HOURS = 12;

/** Reads one cookie, matching the whole name rather than a prefix. */
export function parseCookie(header: string | null, name: string): string | null {
  if (header === null || header.length === 0) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    if (trimmed.slice(0, equals) === name) {
      return trimmed.slice(equals + 1);
    }
  }
  return null;
}

export function sessionCookie(token: string): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${String(SESSION_HOURS * 3600)}`,
  ].join("; ");
}

export function clearedCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readSessionToken(request: Request): string | null {
  return parseCookie(request.headers.get("Cookie"), COOKIE_NAME);
}

export function expiryFrom(now: Date): string {
  return new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString();
}

/** An expiry we cannot read counts as expired: it must never grant access. */
export function isExpired(expiresAt: string, now: Date): boolean {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at <= now.getTime();
}

/** 256 bits of randomness, hex encoded. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
