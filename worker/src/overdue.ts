/**
 * Whether a ticket is still waiting on its first response (R03, R04, R28).
 *
 * Pure: takes the time rather than reading a clock.
 *
 * The rule that matters is R28's: a draft, an internal note or the automatic
 * acknowledgement never satisfies a response deadline. Only a real reply from
 * IT stops the clock. Telling somebody "we received your email" is not an
 * answer, and if it counted, every ticket would look answered within two
 * minutes of arriving and the SLA would measure nothing.
 *
 * That rule is enforced structurally rather than by a check here: the
 * acknowledgement is never written to `messages`, so the caller's
 * firstResponseAt - the earliest outbound message - can only ever be a real
 * reply.
 */

export interface ResponseState {
  /** IT has replied. */
  met: boolean;
  overdue: boolean;
  /** Minutes until due, when still pending and dated. */
  minutesRemaining: number | null;
  /** Minutes past due, when overdue. Lets the worst sort first. */
  minutesOverdue: number | null;
}

const FINISHED = new Set(["Resolved", "Closed"]);

export function responseState(
  responseDue: string | null,
  firstResponseAt: string | null,
  status: string,
  now: Date,
): ResponseState {
  const clear: ResponseState = {
    met: firstResponseAt !== null,
    overdue: false,
    minutesRemaining: null,
    minutesOverdue: null,
  };

  // Answered, or no longer waiting on one.
  if (firstResponseAt !== null || FINISHED.has(status)) {
    return clear;
  }
  // No deadline: the ticket predates them. Treating that as breached would show
  // every old ticket as overdue the moment deadlines shipped.
  if (responseDue === null) {
    return clear;
  }
  const due = Date.parse(responseDue);
  if (Number.isNaN(due)) {
    // A deadline we cannot read is not evidence of a breach.
    return clear;
  }

  const deltaMs = now.getTime() - due;
  if (deltaMs > 0) {
    return {
      met: false,
      overdue: true,
      minutesRemaining: null,
      minutesOverdue: Math.floor(deltaMs / 60_000),
    };
  }
  return {
    met: false,
    overdue: false,
    minutesRemaining: Math.ceil(-deltaMs / 60_000),
    minutesOverdue: null,
  };
}
