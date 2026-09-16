/**
 * Pure business rules. No React, no storage, no mail transport — so these can
 * be tested without a network, a database or a clock, per the architecture
 * rule in docs/engineering-standards.md.
 */

/** R01: only this exact domain may open tickets. */
export const APPROVED_DOMAIN = "allcheckservices.com";

/**
 * Pull the address out of a From header and normalise it.
 *
 * Prefers the angle-bracket form, because a display name is attacker-controlled
 * and can be made to look like anything — `"allcheckservices.com" <bad@evil>`
 * is a real phishing shape. Returns null rather than a guess when the header
 * does not contain exactly one plausible address.
 */
export function extractAddress(header: string): string | null {
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const angled = /<([^<>]*)>\s*$/.exec(trimmed);
  const candidate = (angled?.[1] ?? trimmed).trim().toLowerCase();
  // One @, no whitespace, and a dotted domain. Deliberately strict: anything
  // ambiguous is rejected rather than interpreted.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return null;
  return candidate;
}

/**
 * R01: is this sender allowed to open a ticket?
 *
 * The domain must match exactly. A suffix check would accept
 * `allcheckservices.com.example.org`, which the specification calls out by
 * name, and a subdomain like `mail.allcheckservices.com` is a different mail
 * system that we do not control.
 *
 * Note this is an authorisation gate, not proof of identity: the constitution
 * is explicit that domain matching alone does not authenticate a sender.
 */
export function isApprovedSender(header: string): boolean {
  const address = extractAddress(header);
  if (address === null) return false;
  return address.slice(address.lastIndexOf("@") + 1) === APPROVED_DOMAIN;
}
