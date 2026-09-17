/**
 * Working out which existing ticket an inbound email belongs to (R03, T011).
 *
 * Pure header parsing: no storage, no network. The caller looks the candidates
 * up in order and takes the first hit.
 *
 * Threading is done on Message-ID headers and never on the "[#42]" in a
 * subject. The specification is explicit that merely knowing a ticket number is
 * not enough to join its conversation, and a subject is trivially forged.
 */

/**
 * Pulls the <...> tokens out of a Message-ID, In-Reply-To or References header.
 *
 * Deliberately forgiving about what sits between the tokens: clients fold these
 * headers across lines and some insert commas or commentary. Being strict here
 * would silently start a new ticket for a legitimate reply, which is the
 * failure we are trying to avoid.
 */
export function parseMessageIds(header: string | null | undefined): string[] {
  if (header === null || header === undefined || header.length === 0) {
    return [];
  }
  const found = header.match(/<[^<>\s]+>/g);
  return found === null ? [] : found;
}

/**
 * Message-IDs to try, most likely first.
 *
 * In-Reply-To names the immediate parent and is the strongest signal.
 * References runs oldest first, so it is walked backwards: the newest entries
 * are the closest relatives, and the root is the last resort.
 */
export function threadCandidates(
  inReplyTo: string | null | undefined,
  references: string | null | undefined,
): string[] {
  const ordered = [...parseMessageIds(inReplyTo), ...parseMessageIds(references).reverse()];
  return [...new Set(ordered)];
}
