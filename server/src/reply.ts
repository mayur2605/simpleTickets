/**
 * Composing a public reply from IT to the employee (R13).
 *
 * Pure: no storage, no sockets, caller supplies the time.
 *
 * This module only ever sees text that is meant to be sent. Internal notes are
 * a separate path that never reaches an OutgoingMessage at all - the
 * constitution forbids an internal note reaching employee email, and the safest
 * way to honour that is for the code that builds outgoing mail to have no way
 * to receive one.
 */
import type { OutgoingMessage } from "./mime.ts";
import { subjectWithTicket } from "./acknowledgement.ts";

export interface ReplyInput {
  ticketNumber: number;
  /** The ticket's subject, as first received. Attacker-controlled. */
  ticketSubject: string;
  requester: string;
  supportAddress: string;
  /** What IT wrote. Must not be empty. */
  body: string;
  /** Message-IDs already on this thread, oldest first. */
  threadMessageIds: string[];
  date: Date;
}

export function buildReply(input: ReplyInput): OutgoingMessage {
  if (input.body.trim().length === 0) {
    // Mailing a blank reply looks like a system fault to the employee and
    // satisfies a response deadline without saying anything.
    throw new Error("A reply must have a body.");
  }

  const message: OutgoingMessage = {
    from: input.supportAddress,
    to: [input.requester],
    subject: subjectWithTicket(input.ticketNumber, input.ticketSubject),
    body: input.body,
    messageId: `<reply.${String(input.ticketNumber)}.${String(input.date.getTime())}@simpletickets>`,
    date: input.date,
    // Deliberately NOT autoSubmitted: a person pressed send. Marking it
    // automatic would tell the employee's client not to reply, which is the
    // opposite of what a reply asking for information needs.
  };

  const newest = input.threadMessageIds[input.threadMessageIds.length - 1];
  if (newest === undefined) {
    return message;
  }
  return { ...message, inReplyTo: newest, references: input.threadMessageIds };
}
