/**
 * Recognising delivery failures (R15, R28).
 *
 * A bounce is an automatic message, but it must NOT be discarded as one. R15
 * needs delivery failures visible to IT, and R28 says a bounce arriving after
 * an accepted resolution pauses that ticket's auto-close. Classified before
 * `isAutomaticMessage` for exactly that reason - a null return path alone would
 * otherwise file every bounce as an out-of-office and lose it.
 *
 * Pure header inspection: no storage, no network.
 */
import { parseMessageIds } from "./threading";

/** Line-anchored, so these words appearing in a subject cannot match. */
function headerValue(raw: string, name: string): string | null {
  const found = raw.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "im"));
  return found?.[1] === undefined ? null : found[1].trim();
}

export function isBounce(rawHeaders: string): boolean {
  // RFC 3464: the machine-readable delivery status report.
  const contentType = headerValue(rawHeaders, "content-type") ?? "";
  if (/report-type\s*=\s*"?delivery-status/i.test(contentType)) {
    return true;
  }
  // Fallback for servers that send a human-readable failure instead. Matched on
  // the From header only, never on body text.
  const from = headerValue(rawHeaders, "from") ?? "";
  return /(^|[<\s:])(mailer-daemon|postmaster)@/i.test(from);
}

/**
 * Message-IDs quoted inside a delivery report, so the failed message can be
 * matched back to the outbox row that sent it.
 *
 * A DSN attaches the original message (or at least its headers), so its
 * Message-ID, In-Reply-To and References all appear in the report body. All of
 * them are returned, most useful first, for the caller to look up in order.
 *
 * KNOWN LIMITATION: the caller passes the body as extracted by readBody, which
 * selects the text/plain part of the report - the human-readable notice, not
 * the message/rfc822 part that actually quotes the original headers. Some
 * servers repeat the Message-ID in the readable text and those will match;
 * many will not. Detection is reliable; MATCHING is not, and a bounce that
 * matches nothing is still recorded rather than dropped, with a detail saying
 * so. Reading the message/rfc822 part properly is the fix, and belongs with the
 * rest of R15.
 */
export function bouncedMessageIds(raw: string): string[] {
  const ordered = [
    ...parseMessageIds(headerValue(raw, "message-id")),
    ...parseMessageIds(headerValue(raw, "in-reply-to")),
    ...parseMessageIds(headerValue(raw, "references")),
  ];
  return [...new Set(ordered)];
}
