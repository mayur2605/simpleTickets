/**
 * Reading the support mailbox. Isolated from storage and business rules so the
 * mail provider can change without touching either.
 */
import { ImapFlow } from "imapflow";
import type { MessageStructureObject } from "imapflow";
import { htmlToText, isApprovedSender } from "./domain.ts";
import { MAX_ATTACHMENT_BYTES, safeFilename } from "./storage.ts";

export interface FetchedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface FetchedMessage {
  uid: number;
  from: string;
  subject: string;
  body: string;
  messageId: string | null;
  /** Raw In-Reply-To header, for threading a reply onto its ticket (R03). */
  inReplyTo: string | null;
  /** Raw References header. The envelope does not carry it, so it is fetched. */
  references: string | null;
  /** The fetched header block, for auto-reply detection. */
  rawHeaders: string;
  /**
   * The complete RFC822 source, archived to disk on ingest.
   *
   * Kept because the mailbox is not a database: a message can be deleted from
   * Gmail, and once it is, anything we did not extract at ingestion time is
   * gone. With the source on disk, a later change to parsing is a reparse
   * rather than a re-fetch that may find nothing.
   */
  source: Buffer | null;
  /** Attachments (R12), already bounded to the 5 MB per-email budget. */
  attachments: FetchedAttachment[];
}

/**
 * Pulls one header out of a raw header block, keeping folded continuation
 * lines.
 *
 * Walked line by line rather than matched with one regular expression. The
 * regex version looked right and was wrong: with the multiline flag its `$`
 * matched the end of the FIRST line, so a folded References header lost
 * everything after its first entry - which silently breaks threading for
 * exactly the long conversations that need it most.
 *
 * RFC 5322: a header continues onto the next line when that line begins with a
 * space or tab.
 */
export function readHeader(raw: string, name: string): string | null {
  const target = `${name.toLowerCase()}:`;
  let value: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (value !== null) {
      if (/^[ \t]/.test(line)) {
        value += ` ${line.trim()}`;
        continue;
      }
      break;
    }
    if (line.toLowerCase().startsWith(target)) {
      value = line.slice(target.length).trim();
    }
  }
  return value;
}

export interface MailboxRead {
  uidValidity: string;
  uidNext: number;
  messages: FetchedMessage[];
}

/** Bound a single message before it reaches the database. R12 governs attachments. */
const MAX_BODY_CHARS = 100_000;
/** Bound one run, so a backlog cannot make a cron invocation run away. */
const MAX_PER_RUN = 25;

function makeClient(user: string, appPassword: string): ImapFlow {
  return new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    // Google displays app passwords in groups of four; the spaces are not part
    // of the secret and authentication fails confusingly if they are sent.
    auth: { user, pass: appPassword.replace(/\s+/g, "") },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

/**
 * Mailbox markers only, with no message fetch.
 *
 * Used to establish the launch cutoff on first run: fetching is not merely
 * unnecessary there, it is the part that fails, so the cheapest correct path
 * is to not do it.
 */
export async function readMailboxMarkers(
  user: string,
  appPassword: string,
): Promise<{ uidValidity: string; uidNext: number }> {
  const client = makeClient(user, appPassword);
  client.on("error", () => {
    // Captured by the throw below; an unhandled event would kill the isolate.
  });
  await client.connect();
  try {
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    return { uidValidity: String(box.uidValidity), uidNext: box.uidNext };
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

/**
 * Find the part worth showing on a ticket.
 *
 * Prefers text/plain. Falls back to text/html, because plenty of mail clients
 * send HTML only — this test message did. Returns null for a message with no
 * structure to walk, where the whole body is the text.
 */
export function findBodyPart(
  node: MessageStructureObject | undefined,
): { part: string; type: string } | null {
  if (node === undefined) return null;
  const plain = searchByType(node, "text/plain");
  if (plain !== null) return plain;
  return searchByType(node, "text/html");
}

function searchByType(
  node: MessageStructureObject,
  wanted: string,
): { part: string; type: string } | null {
  if (node.type === wanted) {
    // A single-part message has no part identifier. "TEXT" addresses its body,
    // which is what we want; without this the download returns the entire raw
    // message, headers and all.
    return {
      part: typeof node.part === "string" ? node.part : "TEXT",
      type: node.type,
    };
  }
  for (const child of node.childNodes ?? []) {
    const found = searchByType(child, wanted);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Every part the sender meant as a file.
 *
 * `disposition: attachment` is the explicit marker. An inline part with a
 * filename counts too: mail clients attach photographs that way, and to the
 * employee who attached it the difference is invisible.
 */
export function findAttachmentParts(
  node: MessageStructureObject | undefined,
): { part: string; type: string; filename: string; size: number }[] {
  if (node === undefined) return [];
  const found: { part: string; type: string; filename: string; size: number }[] = [];
  const walk = (current: MessageStructureObject): void => {
    const disposition = current.disposition?.toLowerCase();
    const parameters = current.dispositionParameters as Record<string, string> | undefined;
    const named =
      parameters?.["filename"] ??
      (current.parameters as Record<string, string> | undefined)?.["name"];
    if (
      typeof current.part === "string" &&
      (disposition === "attachment" || (disposition === "inline" && named !== undefined))
    ) {
      found.push({
        part: current.part,
        type: current.type,
        filename: safeFilename(named),
        size: typeof current.size === "number" ? current.size : 0,
      });
    }
    for (const child of current.childNodes ?? []) walk(child);
  };
  walk(node);
  return found;
}

/**
 * Download a message's attachments, stopping at the R12 budget.
 *
 * The budget is enforced on what we actually read, not on the sizes the
 * structure claims: those are the sender's numbers, and a hostile or broken
 * client can understate them.
 */
async function readAttachments(
  client: ImapFlow,
  uid: number,
  structure: MessageStructureObject | undefined,
): Promise<FetchedAttachment[]> {
  const parts = findAttachmentParts(structure);
  const attachments: FetchedAttachment[] = [];
  let budget = MAX_ATTACHMENT_BYTES;

  for (const part of parts) {
    if (budget <= 0) break;
    const { content } = await client.download(String(uid), part.part, { uid: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    for await (const chunk of content) {
      const bytes = Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > budget) {
        overflowed = true;
        break;
      }
      chunks.push(bytes);
    }
    if (overflowed) break;
    budget -= total;
    attachments.push({
      filename: part.filename,
      contentType: part.type,
      content: Buffer.concat(chunks),
    });
  }
  return attachments;
}

/**
 * Fetch one message's body, decoded.
 *
 * Two deliberate choices. One UID at a time, because fetching bodies across a
 * UID range stalls the socket under nodejs_compat while the identical
 * single-UID request succeeds. And download() rather than bodyParts, because
 * download decodes the transfer encoding — bodyParts hands back raw base64.
 */
async function readBody(
  client: ImapFlow,
  uid: number,
  structure: MessageStructureObject | undefined,
): Promise<string> {
  const chosen = findBodyPart(structure);
  const { content } = await client.download(String(uid), chosen === null ? "TEXT" : chosen.part, {
    uid: true,
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of content) {
    const bytes = chunk as Uint8Array;
    chunks.push(bytes);
    total += bytes.length;
    if (total > MAX_BODY_CHARS * 4) break;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(joined);
  const isHtml = chosen?.type === "text/html" || /^\s*<(!doctype|html)/i.test(text);
  return (isHtml ? htmlToText(text) : text).slice(0, MAX_BODY_CHARS).trim();
}

export async function readNewMail(
  user: string,
  appPassword: string,
  sinceUid: number,
): Promise<MailboxRead> {
  const client = makeClient(user, appPassword);
  // Capture rather than discard: an unhandled 'error' event would crash the
  // isolate, but swallowing it hides why a connection died.
  // Held in an object, not a `let`: the assignment below happens inside an
  // error-event closure, and TypeScript's control-flow analysis cannot see it.
  // With a plain variable it narrows to null at the throw site and the socket
  // detail is silently dropped - exactly when a failure needs explaining.
  const socket: { error: string | null } = { error: null };
  client.on("error", (err: unknown) => {
    if (socket.error === null) {
      socket.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  });

  let stage = "connect";
  try {
    await client.connect();
    stage = "mailboxOpen";
    // Read-only: ingestion must not mark anything as seen. The database is the
    // record of what has been processed, not the mailbox's flags.
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    stage = "fetch";
    const messages: FetchedMessage[] = [];

    // `N:*` always returns at least the newest message even when none are
    // above N, so every UID is re-checked against sinceUid below.
    //
    // fetchAll buffers rather than streaming. imapflow's async-generator
    // fetch() times out under nodejs_compat - connect and mailboxOpen work,
    // the streaming read does not.
    const fetched = await client.fetchAll(
      { uid: `${String(sinceUid + 1)}:*` },
      // `references` is not in the IMAP envelope, so it has to be asked for
      // explicitly. Without it a reply whose client omits In-Reply-To would
      // open a second ticket instead of joining its own conversation.
      {
        uid: true,
        envelope: true,
        bodyStructure: true,
        // The complete message, archived to disk by the pipeline.
        source: true,
        headers: [
          // Threading (R03).
          "in-reply-to",
          "references",
          // Automatic-message detection (RFC 3834 and older conventions).
          "auto-submitted",
          "precedence",
          "x-autoreply",
          "x-autorespond",
          "return-path",
          // Bounce detection (R15). content-type carries
          // report-type=delivery-status; from identifies mailer-daemon. Without
          // BOTH of these isBounce can never match, and every delivery failure
          // is misfiled as an out-of-office.
          "content-type",
          "from",
        ],
      },
      { uid: true },
    );

    for (const message of fetched) {
      if (message.uid <= sinceUid) continue;
      if (messages.length >= MAX_PER_RUN) break;

      const envelope = message.envelope;
      const sender = envelope?.from?.[0];
      const from =
        sender === undefined
          ? ""
          : sender.name
            ? `${sender.name} <${sender.address ?? ""}>`
            : (sender.address ?? "");

      const body = await readBody(client, message.uid, message.bodyStructure);
      // Validated rather than trusted: imapflow types this loosely, and a
      // shape change should degrade to "" rather than throw mid-ingestion.
      const rawHeaders: unknown = message.headers;
      const headers =
        typeof rawHeaders === "string"
          ? rawHeaders
          : rawHeaders instanceof Uint8Array
            ? new TextDecoder().decode(rawHeaders)
            : "";

      messages.push({
        uid: message.uid,
        from,
        subject: envelope?.subject ?? "(no subject)",
        body,
        messageId: envelope?.messageId ?? null,
        inReplyTo: envelope?.inReplyTo ?? readHeader(headers, "in-reply-to"),
        references: readHeader(headers, "references"),
        rawHeaders: headers,
        source: message.source instanceof Uint8Array ? Buffer.from(message.source) : null,
        attachments: await readAttachments(client, message.uid, message.bodyStructure),
      });
    }

    return {
      uidValidity: String(box.uidValidity),
      uidNext: box.uidNext,
      messages,
    };
  } catch (error) {
    const base = error instanceof Error ? error.message : String(error);
    throw new Error(
      `IMAP failed at ${stage}: ${base}${socket.error === null ? "" : ` (socket: ${socket.error})`}`,
      { cause: error },
    );
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

/** Diagnostic: which folders exist and how much is in each. */
export async function listFolders(
  user: string,
  appPassword: string,
): Promise<{ path: string; messages: number; uidNext: number }[]> {
  const client = makeClient(user, appPassword);
  client.on("error", () => {
    // Surfaced by the throw from the caller.
  });
  await client.connect();
  try {
    const out: { path: string; messages: number; uidNext: number }[] = [];
    for (const folder of await client.list()) {
      try {
        const box = await client.mailboxOpen(folder.path, { readOnly: true });
        out.push({ path: folder.path, messages: box.exists, uidNext: box.uidNext });
      } catch {
        out.push({ path: folder.path, messages: -1, uidNext: -1 });
      }
    }
    return out;
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

export interface PeekedMessage {
  uid: number;
  from: string;
  subject: string;
  date: string | null;
  /** True when this message would be accepted as an employee request. */
  approvedSender: boolean;
  /**
   * Envelope recipients. Shown because the sender alone cannot distinguish mail
   * forwarded from the published address from mail sent straight to this
   * mailbox, and that difference is what proves the forward works.
   */
  to: string[];
}

/**
 * Read-only look at the newest messages: envelopes only, no bodies, no
 * ingestion, no outgoing mail.
 *
 * Exists so the mailbox can be inspected without `/poll`, which now creates
 * tickets AND sends acknowledgements to real people. Checking what arrived
 * should never be able to mail somebody.
 */
export async function peekRecent(
  user: string,
  appPassword: string,
  count = 10,
): Promise<{ uidNext: number; messages: PeekedMessage[] }> {
  const client = makeClient(user, appPassword);
  await client.connect();
  try {
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    const from = Math.max(1, box.uidNext - count);
    const fetched = await client.fetchAll(
      { uid: `${String(from)}:*` },
      { uid: true, envelope: true },
      { uid: true },
    );
    const messages = fetched.map((message) => {
      const sender = message.envelope?.from?.[0];
      const address = sender?.address ?? "";
      const display =
        sender?.name === undefined || sender.name === "" ? address : `${sender.name} <${address}>`;
      return {
        uid: message.uid,
        from: display,
        to: (message.envelope?.to ?? [])
          .map((recipient) => recipient.address ?? "")
          .filter((address) => address.length > 0),
        subject: message.envelope?.subject ?? "(no subject)",
        // imapflow types this as string | Date depending on the server's reply.
        date:
          message.envelope?.date instanceof Date
            ? message.envelope.date.toISOString()
            : (message.envelope?.date ?? null),
        approvedSender: isApprovedSender(display),
      };
    });
    return { uidNext: box.uidNext, messages };
  } finally {
    try {
      await client.logout();
    } catch {
      // already closed
    }
  }
}
