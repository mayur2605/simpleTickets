/**
 * The automatic acknowledgement an employee receives when their email opens a
 * ticket (R02).
 *
 * Pure composition: no sockets, no storage, no clock of its own. The caller
 * supplies the time so tests are deterministic.
 *
 * Two rules from the specification shape this, and both are easy to get wrong:
 *
 *   R28 - an automatic acknowledgement never satisfies a transition or a
 *   response deadline. It is not a reply from IT and must not read like one,
 *   or an employee will believe they have been answered when nobody has looked
 *   at the ticket yet.
 *
 *   spec.md - "Merely knowing a ticket number is insufficient." Threading has
 *   to work from real Message-ID/In-Reply-To/References headers. The visible
 *   "[#42]" is a convenience for humans, never the basis for authorising a
 *   reply.
 */
import type { OutgoingMessage } from "./mime";

export interface AcknowledgementInput {
  ticketNumber: number;
  /** Subject of the employee's email, as received. Attacker-controlled. */
  originalSubject: string;
  /** Employee's address, already validated as an approved sender. */
  requester: string;
  /** Full From header value for the support mailbox. */
  supportAddress: string;
  /** Message-ID of the email that opened the ticket, or null if it had none. */
  inboundMessageId: string | null;
  date: Date;
}

/**
 * Prefixes the ticket tag unless this exact ticket's tag is already present,
 * so a subject does not accumulate "[#42] [#42] [#42]" over a conversation.
 * A different ticket's tag is left alone: it is part of the subject text, not
 * ours to reinterpret.
 */
export function subjectWithTicket(ticketNumber: number, originalSubject: string): string {
  const tag = `[#${String(ticketNumber)}]`;
  const trimmed = originalSubject.trim();
  if (trimmed.length === 0) {
    return `${tag} (no subject)`;
  }
  return trimmed.includes(tag) ? trimmed : `${tag} ${trimmed}`;
}

export function buildAcknowledgement(input: AcknowledgementInput): OutgoingMessage {
  const number = String(input.ticketNumber);

  // Deliberately plain, and explicit that no one has looked at it yet (R28).
  const body = [
    `Thanks - we have your request and opened ticket #${number}.`,
    "",
    "Our IT team will pick it up during working hours, Monday to Saturday,",
    "09:00 to 18:00. This message is automatic and does not mean anyone has",
    "looked at the ticket yet.",
    "",
    "To add anything, just reply to this email and it will be attached to the",
    "same ticket.",
  ].join("\n");

  const message: OutgoingMessage = {
    from: input.supportAddress,
    to: [input.requester],
    subject: subjectWithTicket(input.ticketNumber, input.originalSubject),
    body,
    // Unique per acknowledgement so a later reply threads to this exact
    // message rather than colliding with another ticket's.
    messageId: `<ack.${number}.${String(input.date.getTime())}@simpletickets>`,
    date: input.date,
    autoSubmitted: true,
  };

  // exactOptionalPropertyTypes: these keys must be absent, not set to
  // undefined, when the inbound message carried no Message-ID.
  if (input.inboundMessageId !== null) {
    return {
      ...message,
      inReplyTo: input.inboundMessageId,
      references: [input.inboundMessageId],
    };
  }
  return message;
}
