/**
 * Reading the support mailbox. Isolated from storage and business rules so the
 * mail provider can change without touching either.
 */
import { ImapFlow } from "imapflow";

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

export async function readNewMail(
  user: string,
  appPassword: string,
  sinceUid: number,
): Promise<MailboxRead> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    // Google displays app passwords in groups of four; the spaces are not part
    // of the secret and authentication fails confusingly if they are sent.
    auth: { user, pass: appPassword.replace(/\s+/g, "") },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  client.on("error", () => {
    // Consumed; the caller sees the thrown error instead.
  });

  await client.connect();
  try {
    // Read-only: ingestion must not mark anything as seen. The database is the
    // record of what has been processed, not the mailbox's flags.
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    const messages: FetchedMessage[] = [];

    // `N:*` always returns at least the newest message even when none are
    // above N, so every UID is re-checked against sinceUid below.
    for await (const message of client.fetch(
      { uid: `${String(sinceUid + 1)}:*` },
      { uid: true, envelope: true, bodyParts: ["text"] },
      { uid: true },
    )) {
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

      const raw = message.bodyParts?.get("text");
      const body =
        raw === undefined ? "" : new TextDecoder().decode(raw).slice(0, MAX_BODY_CHARS);

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
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
