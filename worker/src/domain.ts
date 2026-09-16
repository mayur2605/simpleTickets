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

/**
 * Strip tags so an HTML-only message is readable as ticket text.
 *
 * Deliberately crude: scripts and styles removed, block tags become newlines,
 * the handful of entities that actually appear in mail decoded. It is not a
 * sanitiser and its output is never rendered as HTML — the dashboard will show
 * it as text. Storing the original HTML as well is a later decision.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    // A paragraph is a visual break, so it earns a blank line. Divs and rows
    // are often nested three deep in mail HTML and would otherwise produce a
    // wall of blank lines, so they get a single newline.
    .replace(/<\/(p|h[1-6])>/gi, "\n\n")
    .replace(/<\/(div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

