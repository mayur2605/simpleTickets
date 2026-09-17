/**
 * Choosing who a new ticket goes to (R07).
 *
 * Pure: no storage, no clock. The caller supplies current workloads and who was
 * assigned last.
 *
 * The rule is "fewest open tickets, round robin for ties". The tie-breaking
 * matters more than it sounds: without it a small team with an equal, quiet
 * queue would send every ticket to whoever happens to sort first, and that
 * person would carry the whole load while the rule appeared to be balancing.
 */

export interface StaffWorkload {
  name: string;
  /** Open tickets currently owned: New, In Progress, Waiting for Employee. */
  openTickets: number;
  /** Admin-controlled. Unavailable staff receive nothing. */
  available: boolean;
}

/**
 * Returns the chosen assignee, or null when nobody can take it.
 *
 * Null means the ticket stays unassigned and admin is alerted. Handing it to an
 * unavailable person instead would make it look assigned while nobody works it,
 * which is worse than visibly unassigned.
 */
export function chooseAssignee(staff: StaffWorkload[], lastAssigned: string | null): string | null {
  // Sorted by name so the result cannot depend on the order rows came out of
  // the database; two callers reading the same table must assign identically.
  const available = staff
    .filter((member) => member.available)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (available.length === 0) return null;

  const fewest = Math.min(...available.map((member) => member.openTickets));
  const tied = available.filter((member) => member.openTickets === fewest);

  const first = tied[0];
  if (first === undefined) return null;
  if (tied.length === 1) return first.name;

  // Rotate: take the first tied member after whoever went last. An unknown or
  // now-unavailable lastAssigned falls through to the first, which is the same
  // answer as starting fresh.
  const previous = tied.findIndex((member) => member.name === lastAssigned);
  if (previous === -1) return first.name;
  const next = tied[(previous + 1) % tied.length];
  return next === undefined ? first.name : next.name;
}
