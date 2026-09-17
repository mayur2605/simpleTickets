/**
 * One-way notification emails to IT staff (R15, R18).
 *
 * Pure composition: no sockets, no storage, no clock of its own.
 *
 * Three rules from the specification shape this, and each is enforced by what
 * this module *cannot* do rather than by a check somewhere:
 *
 *   No internal-note content ever reaches a notification. This builder is
 *   never given note text — it takes a ticket's subject, requester and status
 *   and nothing else — so there is no code path from a note to an outgoing
 *   message, in either direction (see also store.addNote).
 *
 *   Every notification links to the ticket in the dashboard. The body is
 *   deliberately thin: the dashboard is where IT works (R04), and a
 *   notification that quoted the conversation would become a second, worse
 *   place to read it.
 *
 *   Replying to one must not reach the ticket. That cannot be arranged by
 *   asking nicely, because staff are on the approved sender domain and their
 *   reply WOULD otherwise be ingested as though the employee had written it —
 *   restarting the response clock and reopening a resolved ticket. The
 *   structural half lives in store.findTicketByMessageIds, which refuses to
 *   thread on a notification's Message-ID; this module's half is the
 *   Reply-To below and saying so in the text.
 */
import { randomUUID } from "node:crypto";
import type { OutgoingMessage } from "./mime.ts";
import { subjectWithTicket } from "./acknowledgement.ts";

export type NotificationKind =
  "assigned" | "employee_reply" | "overdue" | "delivery_failed" | "unassigned";

export interface NotificationInput {
  kind: NotificationKind;
  ticketNumber: number;
  ticketSubject: string;
  requester: string;
  /** Full From header for the support mailbox. */
  supportAddress: string;
  /** Where this staff member reads tickets. */
  dashboardUrl: string;
  recipient: string;
  date: Date;
  /** Only for "overdue": how far past the deadline, in minutes. */
  minutesOverdue?: number;
}

function headline(input: NotificationInput): string {
  const number = String(input.ticketNumber);
  switch (input.kind) {
    case "assigned":
      return `Ticket #${number} is yours`;
    case "employee_reply":
      return `New employee reply on ticket #${number}`;
    case "overdue":
      return `Response overdue on ticket #${number}`;
    case "delivery_failed":
      return `Delivery failed on ticket #${number}`;
    case "unassigned":
      return `Ticket #${number} has nobody to work it`;
  }
}

function explain(input: NotificationInput): string[] {
  switch (input.kind) {
    case "assigned":
      return ["This ticket has been assigned to you."];
    case "employee_reply":
      return ["The employee has added something to this ticket."];
    case "overdue": {
      const late =
        input.minutesOverdue === undefined
          ? "The first-response deadline has passed."
          : `The first-response deadline passed ${String(Math.floor(input.minutesOverdue / 60))}h ${String(input.minutesOverdue % 60)}m ago.`;
      // R18: reminders repeat until IT replies, so the way to stop them is
      // worth stating - otherwise the obvious guess is to reply to this email,
      // which does nothing.
      return [late, "Reminders repeat every four working hours until you reply."];
    }
    case "delivery_failed":
      // R28: a bounce after acceptance pauses auto-close and must be visible.
      return [
        "An email this ticket depends on was accepted by the mail server and then bounced.",
        "Automatic closure is paused until delivery is fixed.",
      ];
    case "unassigned":
      // R24: when nobody is available the ticket is left visibly unassigned
      // rather than handed to someone who cannot work it - which only helps if
      // somebody is told, because an unassigned ticket has no assignee to remind.
      return [
        "No IT staff member was available, so this ticket has not been assigned.",
        "The response deadline is running regardless.",
      ];
  }
}

export function buildNotification(input: NotificationInput): OutgoingMessage {
  const number = String(input.ticketNumber);
  const link = `${input.dashboardUrl.replace(/\/+$/, "")}/tickets/${number}`;

  const body = [
    ...explain(input),
    "",
    `Ticket:    #${number} ${input.ticketSubject}`,
    `Employee:  ${input.requester}`,
    "",
    `Open it:   ${link}`,
    "",
    "Do not reply to this email. It is sent automatically, replies are not",
    "read, and replying does not satisfy the response deadline. Work the",
    "ticket in the dashboard.",
  ].join("\n");

  return {
    from: input.supportAddress,
    to: [input.recipient],
    subject: subjectWithTicket(input.ticketNumber, headline(input)),
    body,
    // Distinct prefix so these are recognisable in the outbox and, more
    // importantly, so store.findTicketByMessageIds can refuse to thread on one.
    //
    // The random suffix is not decoration. One overdue reminder goes to the
    // assignee AND every admin (R18), all built in the same millisecond for the
    // same ticket and kind - so a timestamp alone produced identical
    // Message-IDs, and outbox's UNIQUE constraint silently dropped every
    // recipient after the first. Everyone but one person stopped being told.
    messageId: `<notify.${input.kind}.${number}.${randomUUID()}@simpletickets>`,
    date: input.date,
    // RFC 3834. A well-behaved mail client will not send an out-of-office back
    // at this, and our own ingestion filters it if one does.
    autoSubmitted: true,
    // Bounces go to the support mailbox, where the outbox can see them; a
    // human reply lands somewhere that is nobody's inbox.
    replyTo: "no-reply@allcheckservices.com",
  };
}
