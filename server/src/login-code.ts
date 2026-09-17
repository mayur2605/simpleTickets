/**
 * The email carrying a sign-in code (R06).
 *
 * Pure composition, like every other builder here: no sockets, no storage, no
 * clock of its own.
 *
 * Two things this message deliberately does not do. It does not link anywhere -
 * a sign-in email with a clickable link is the shape of every credential
 * phishing message ever sent, and training staff to click one is worse than the
 * inconvenience of typing six digits. And it does not say what the code is for
 * beyond "signing in", because the message goes to a mailbox and a mailbox is
 * not the ticket system.
 */
import { randomUUID } from "node:crypto";
import type { OutgoingMessage } from "./mime.ts";
import { CODE_MINUTES } from "./session.ts";

export interface LoginCodeInput {
  code: string;
  recipient: string;
  /** Full From header for the support mailbox. */
  supportAddress: string;
  date: Date;
}

export function buildLoginCode(input: LoginCodeInput): OutgoingMessage {
  return {
    from: input.supportAddress,
    to: [input.recipient],
    subject: `SimpleTickets sign-in code: ${input.code}`,
    body: [
      `Your sign-in code is ${input.code}`,
      "",
      `It works once and expires in ${String(CODE_MINUTES)} minutes.`,
      "",
      "If you did not just try to sign in, somebody has your password. Change",
      "it and tell your administrator. This code alone does not let them in.",
      "",
      "Nobody from IT will ever ask you for this code.",
    ].join("\n"),
    messageId: `<signin.${randomUUID()}@simpletickets>`,
    date: input.date,
    autoSubmitted: true,
    replyTo: "no-reply@allcheckservices.com",
  };
}
