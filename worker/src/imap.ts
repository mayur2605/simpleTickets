/**
 * Reading the support mailbox. Isolated from storage and business rules so the
 * mail provider can change without touching either.
 */
import { ImapFlow } from "imapflow";
import type { MessageStructureObject } from "imapflow";
import { htmlToText } from "./domain";

export interface FetchedMessage {
  uid: number;
  from: string;
  subject: string;
  body: string;
  messageId: string | null;
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
function findBodyPart(
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
  const { content } = await client.download(
    String(uid),
    chosen === null ? "TEXT" : chosen.part,
    { uid: true },
  );
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
  let socketError: string | null = null;
  client.on("error", (err: unknown) => {
    if (socketError === null) {
      socketError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
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
      { uid: true, envelope: true, bodyStructure: true },
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

      messages.push({
        uid: message.uid,
        from,
        subject: envelope?.subject ?? "(no subject)",
        body,
        messageId: envelope?.messageId ?? null,
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
      `IMAP failed at ${stage}: ${base}${socketError === null ? "" : ` (socket: ${socketError})`}`,
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
