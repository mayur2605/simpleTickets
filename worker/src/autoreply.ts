/**
 * Recognising mail that no human sent.
 *
 * This is the other half of the contract in `acknowledgement.ts`: we mark our
 * own acknowledgement `Auto-Submitted: auto-replied` so nobody's autoresponder
 * answers it, and we honour the same marker on the way in.
 *
 * It matters beyond tidiness. An out-of-office reply to our acknowledgement
 * would otherwise be threaded onto the ticket as a genuine employee reply -
 * restarting the response clock, reopening a Resolved ticket, and doing it
 * again every time. Pure header inspection: no storage, no network.
 */

/** Headers whose mere presence (with a plausible value) means "not a person". */
const AUTO_HEADERS: ReadonlyArray<readonly [name: string, test: (value: string) => boolean]> = [
  // RFC 3834: any value except "no" means automatic.
  ["auto-submitted", (value) => value.toLowerCase() !== "no"],
  // Pre-RFC convention, still widely emitted.
  ["precedence", (value) => ["bulk", "junk", "auto_reply", "list"].includes(value.toLowerCase())],
  ["x-autoreply", () => true],
  ["x-autorespond", () => true],
  // The null reverse path. Bounces and system mail use it so that replying is
  // impossible, which makes it a reliable tell.
  ["return-path", (value) => value === "<>"],
];

function headerValue(raw: string, name: string): string | null {
  // Anchored to the start of a line so the words appearing in a subject or body
  // cannot trigger a match.
  const found = raw.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "im"));
  return found?.[1] === undefined ? null : found[1].trim();
}

export function isAutomaticMessage(rawHeaders: string): boolean {
  return AUTO_HEADERS.some(([name, test]) => {
    const value = headerValue(rawHeaders, name);
    return value !== null && test(value);
  });
}
