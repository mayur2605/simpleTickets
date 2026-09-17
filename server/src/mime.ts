/**
 * Builds an RFC 5322 message for SMTP submission.
 *
 * Pure string work: no sockets, no storage, no clock of its own. The transport
 * in `smtp.ts` hands the result straight to DATA.
 *
 * The important job here is not formatting, it is refusing to build a message
 * that an employee's email could have tampered with. Subjects and addresses
 * reach us from inbound mail, so they are attacker-controlled; a bare CR or LF
 * in one would terminate its header and let the sender append headers of their
 * own, Bcc included.
 */

export class HeaderInjectionError extends Error {
  constructor(field: string) {
    super(`${field} contains a line break and cannot be used in a header`);
    this.name = "HeaderInjectionError";
  }
}

export interface OutgoingMessage {
  /** Full From header value, display name optional. */
  from: string;
  to: string[];
  /**
   * Eligible company-domain CC participants (R25).
   *
   * Carried on the message rather than fanned out into one outbox row per
   * person: a reply is one conversation, and giving each recipient their own
   * row would make each of them a separate Message-ID that threads apart.
   */
  cc?: string[];
  subject: string;
  /** Plain text. Line endings are normalised and dot-stuffed here. */
  body: string;
  /** Our own Message-ID, so a later reply can be threaded back to this one. */
  messageId: string;
  date: Date;
  /** Message-ID being replied to (R03 threading). */
  inReplyTo?: string;
  /** Full References chain, oldest first (R03 threading). */
  references?: string[];
  /**
   * RFC 3834. Set on anything generated without a human pressing send, so
   * other autoresponders know not to answer it. Without it, this system's
   * acknowledgement and someone's out-of-office can reply to each other
   * indefinitely.
   */
  autoSubmitted?: boolean;
  /**
   * Where replies should go, when that is not the From address.
   *
   * Used by one-way staff notifications (R15). IT staff are on the approved
   * sender domain, so a reply to a notification would otherwise be ingested as
   * though the employee had written it.
   */
  replyTo?: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function assertHeaderSafe(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new HeaderInjectionError(field);
  }
  return value;
}

/**
 * Timestamps are stored and sent in UTC; business time is a separate concern
 * handled by the calendar module.
 */
function rfc5322Date(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  // getUTCDay()/getUTCMonth() are always in range. The fallbacks exist only to
  // satisfy noUncheckedIndexedAccess without a non-null assertion, which is banned.
  const day = DAYS[date.getUTCDay()] ?? "Sun";
  const month = MONTHS[date.getUTCMonth()] ?? "Jan";
  return (
    `${day}, ${pad(date.getUTCDate())} ${month} ${String(date.getUTCFullYear())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * A header value containing non-ASCII must be encoded or it arrives as
 * mojybake. RFC 2047 encoded-word, base64 variant.
 */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- the ASCII range is the point
  return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${base64Utf8(value)}?=`;
}

/**
 * RFC 5321: a line containing only "." ends DATA. Any body line that starts
 * with "." must be doubled, or the message is silently truncated there.
 */
function normaliseAndDotStuff(body: string): string {
  const normalised = body.replace(/\r\n|\r|\n/g, "\r\n");
  const stuffed = normalised.replace(/\r\n\./g, "\r\n..");
  return stuffed.startsWith(".") ? `.${stuffed}` : stuffed;
}

export function buildMessage(message: OutgoingMessage): string {
  const from = assertHeaderSafe(message.from, "from");
  const recipients = message.to.map((address, index) =>
    assertHeaderSafe(address, `to[${String(index)}]`),
  );
  const subject = assertHeaderSafe(message.subject, "subject");
  const messageId = assertHeaderSafe(message.messageId, "messageId");

  const headers: string[] = [
    `From: ${from}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${rfc5322Date(message.date)}`,
    `Message-ID: ${messageId}`,
  ];

  if (message.cc !== undefined && message.cc.length > 0) {
    const copied = message.cc.map((address, index) =>
      assertHeaderSafe(address, `cc[${String(index)}]`),
    );
    headers.push(`Cc: ${copied.join(", ")}`);
  }

  if (message.inReplyTo !== undefined) {
    headers.push(`In-Reply-To: ${assertHeaderSafe(message.inReplyTo, "inReplyTo")}`);
  }
  if (message.references !== undefined && message.references.length > 0) {
    const chain = message.references.map((reference, index) =>
      assertHeaderSafe(reference, `references[${String(index)}]`),
    );
    headers.push(`References: ${chain.join(" ")}`);
  }

  if (message.replyTo !== undefined) {
    headers.push(`Reply-To: ${assertHeaderSafe(message.replyTo, "replyTo")}`);
  }

  if (message.autoSubmitted === true) {
    headers.push("Auto-Submitted: auto-replied");
  }

  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8");

  return `${headers.join("\r\n")}\r\n\r\n${normaliseAndDotStuff(message.body)}`;
}

/**
 * Revives an OutgoingMessage stored as JSON in the outbox.
 *
 * A database projection is an external boundary: the row may predate a code
 * change, or have been written by a different version. Validate rather than
 * cast, so a malformed row fails here instead of halfway through an SMTP DATA
 * command with a half-written message on the wire.
 */
export function parseOutgoingMessage(json: string): OutgoingMessage {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("Stored message is not an object.");
  }
  const value = raw as Record<string, unknown>;

  const text = (field: string): string => {
    const found = value[field];
    if (typeof found !== "string" || found.length === 0) {
      throw new TypeError(`Stored message field "${field}" is missing or not a string.`);
    }
    return found;
  };

  const to = value["to"];
  if (!Array.isArray(to) || to.length === 0 || !to.every((x) => typeof x === "string")) {
    throw new TypeError('Stored message field "to" must be a non-empty array of strings.');
  }

  const date = new Date(text("date"));
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Stored message field "date" is not a valid timestamp.');
  }

  const message: OutgoingMessage = {
    from: text("from"),
    to,
    subject: text("subject"),
    body: typeof value["body"] === "string" ? value["body"] : "",
    messageId: text("messageId"),
    date,
  };

  // exactOptionalPropertyTypes: absent, never explicitly undefined.
  const references = value["references"];
  const cc = value["cc"];
  return {
    ...message,
    ...(Array.isArray(cc) && cc.length > 0 && cc.every((x) => typeof x === "string") ? { cc } : {}),
    ...(typeof value["inReplyTo"] === "string" ? { inReplyTo: value["inReplyTo"] } : {}),
    ...(Array.isArray(references) && references.every((x) => typeof x === "string")
      ? { references }
      : {}),
    ...(value["autoSubmitted"] === true ? { autoSubmitted: true } : {}),
    ...(typeof value["replyTo"] === "string" ? { replyTo: value["replyTo"] } : {}),
  };
}
