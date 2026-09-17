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
import { parseMessageIds } from "./threading.ts";

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
 * matched back to the outbox row that sent it (R15, R28).
 *
 * Give this the COMPLETE raw source, not the extracted body. A DSN is a
 * multipart/report whose third part is `message/rfc822` — the original message,
 * or at least its headers. `readBody` returns the first part, the human-readable
 * "your message could not be delivered" notice, which is exactly the part that
 * usually quotes nothing. Matching used to fail for that reason alone.
 *
 * The bounce's OWN header block is skipped. Its Message-ID belongs to the
 * report, not to the message that failed, and returning it first meant the
 * caller's lookup tried a Message-ID that can never be in the outbox before the
 * one that is.
 *
 * Everything after that block is scanned wholesale rather than parsed as MIME.
 * Walking the part structure would need a boundary parser for a job that comes
 * down to "find the angle-bracket tokens after these header names", and the
 * only cost of the crude version is finding an id that matches nothing — which
 * is already the handled case.
 */
export function bouncedMessageIds(raw: string): string[] {
  // The first blank line ends the report's own headers. A DSN with no blank
  // line at all is a fragment, and scanning all of it is the right fallback.
  const split = raw.search(/\r?\n\r?\n/);
  const quoted = split === -1 ? raw : raw.slice(split);

  const ordered: string[] = [];
  for (const name of ["message-id", "in-reply-to", "references", "original-message-id"]) {
    // Every occurrence, not just the first: the readable notice and the
    // attached original often both carry one, and the bodies of forwarded
    // reports can carry several.
    const pattern = new RegExp(`^${name}:[ \\t]*(.*)$`, "gim");
    for (const match of quoted.matchAll(pattern)) {
      ordered.push(...parseMessageIds(match[1]));
    }
  }
  return [...new Set(ordered)];
}
