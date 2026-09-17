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
  /**
   * Eligible company-domain CC participants (R25), already filtered by the
   * caller. Empty or absent means a plain two-party reply.
   */
  participants?: string[];
  supportAddress: string;
  /** What IT wrote. Must not be empty. */
  body: string;
  /**
   * The staff member answering (R14: "signed with the responding staff member's
   * name").
   *
   * Appended here rather than typed by each person, so it cannot be forgotten
   * and cannot claim somebody else - the caller takes it from the session. An
   * automatic message passes nothing, because "IT Support" signing an
   * auto-closure is a fiction: nobody pressed anything.
   */
  signedBy?: string;
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

  // The requester is always the addressee; everyone else is copied. Dropping
  // the requester from the Cc list matters - a client that sees the same
  // address twice shows it twice, and some send two copies.
  const copied = (input.participants ?? []).filter(
    (address) => address.toLowerCase() !== input.requester.toLowerCase(),
  );

  const signed =
    input.signedBy === undefined || input.signedBy.trim() === ""
      ? input.body
      : `${input.body.replace(/\s+$/, "")}\n\n--\n${input.signedBy}\nIT Support`;

  const message: OutgoingMessage = {
    from: input.supportAddress,
    to: [input.requester],
    ...(copied.length > 0 ? { cc: copied } : {}),
    subject: subjectWithTicket(input.ticketNumber, input.ticketSubject),
    body: signed,
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
