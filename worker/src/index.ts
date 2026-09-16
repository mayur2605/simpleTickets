/**
 * SimpleTickets ingestion worker.
 *
 * Runs on a two-minute cron (R02), reads new mail from the support mailbox and
 * opens one ticket per approved message.
 *
 * Two properties matter more than anything else here:
 *
 *   Idempotency. Cron runs can overlap and retry, and `N:*` re-reports the
 *   newest UID even when nothing is new. Every UID is therefore checked against
 *   ingest_log before processing and recorded in the same transaction as the
 *   ticket, so one email can never open two tickets.
 *
 *   The launch cutoff (R27). On first run the checkpoint is initialised to the
 *   mailbox's current uidNext and nothing is imported, so pre-existing mail
 *   never becomes a ticket.
 */
import { readNewMail, readMailboxMarkers } from "./imap";
import { isApprovedSender, extractAddress } from "./domain";
import {
  readCheckpoint,
  writeCheckpoint,
  alreadyIngested,
  createTicket,
  recordSkip,
} from "./store";

interface Env {
  DB: D1Database;
  GMAIL_USER: string;
  GMAIL_APP_PASSWORD: string;
  ADMIN_TOKEN: string;
}

interface RunSummary {
  initialised?: boolean;
  uidValidityChanged?: boolean;
  examined: number;
  created: number;
  rejected: number;
  skipped: number;
  lastUid: number;
}

async function ingest(env: Env): Promise<RunSummary> {
  const existing = await readCheckpoint(env.DB);

  // First run: adopt the mailbox as-is and import nothing (R27).
  if (existing === null) {
    const probe = await readMailboxMarkers(env.GMAIL_USER, env.GMAIL_APP_PASSWORD);
    await writeCheckpoint(env.DB, {
      uidValidity: probe.uidValidity,
      lastUid: probe.uidNext - 1,
    });
    return {
      initialised: true,
      examined: 0,
      created: 0,
      rejected: 0,
      skipped: 0,
      lastUid: probe.uidNext - 1,
    };
  }

  const read = await readNewMail(env.GMAIL_USER, env.GMAIL_APP_PASSWORD, existing.lastUid);

  // UIDVALIDITY changing means the server has renumbered every message, so the
  // stored UID means nothing any more. Re-anchor to the current uidNext rather
  // than re-importing the mailbox; ingest_log still prevents duplicates for
  // anything already seen.
  if (read.uidValidity !== existing.uidValidity) {
    await writeCheckpoint(env.DB, {
      uidValidity: read.uidValidity,
      lastUid: read.uidNext - 1,
    });
    return {
      uidValidityChanged: true,
      examined: 0,
      created: 0,
      rejected: 0,
      skipped: 0,
      lastUid: read.uidNext - 1,
    };
  }

  let created = 0;
  let rejected = 0;
  let skipped = 0;
  let highest = existing.lastUid;

  for (const message of read.messages) {
    highest = Math.max(highest, message.uid);

    if (await alreadyIngested(env.DB, message.uid)) {
      skipped += 1;
      continue;
    }

    // R01. Note this authorises, it does not authenticate: the constitution is
    // explicit that a matching domain is not proof of who sent the message.
    if (!isApprovedSender(message.from)) {
      await recordSkip(env.DB, message.uid, "rejected_sender", "Sender outside the approved domain");
      rejected += 1;
      continue;
    }

    const requester = extractAddress(message.from);
    if (requester === null) {
      await recordSkip(env.DB, message.uid, "error", "Could not parse sender address");
      rejected += 1;
      continue;
    }

    await createTicket(env.DB, {
      uid: message.uid,
      subject: message.subject,
      requester,
      body: message.body,
      messageId: message.messageId,
    });
    created += 1;
  }

  // Advance only after processing, so a crash mid-run re-examines rather than
  // skips. ingest_log makes re-examination harmless.
  if (highest > existing.lastUid) {
    await writeCheckpoint(env.DB, { uidValidity: read.uidValidity, lastUid: highest });
  }

  return { examined: read.messages.length, created, rejected, skipped, lastUid: highest };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const summary = await ingest(env);
    // Counts only: subjects and addresses stay out of the logs.
    console.log(JSON.stringify({ source: "cron", ...summary }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const token = env.ADMIN_TOKEN;
    const given = request.headers.get("x-admin-token");
    if (
      typeof token !== "string" ||
      token.length < 20 ||
      given === null ||
      !timingSafeEqual(given, token)
    ) {
      return new Response("Not found", { status: 404 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/status") {
      const checkpoint = await readCheckpoint(env.DB);
      const counts = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM tickets)    AS tickets,
           (SELECT COUNT(*) FROM messages)   AS messages,
           (SELECT COUNT(*) FROM ingest_log) AS examined`,
      ).first<{ tickets: number; messages: number; examined: number }>();
      return Response.json({ checkpoint, counts });
    }

    if (url.pathname === "/diag") {
      // Where did the mail actually land? Gmail files unknown senders in Spam,
      // which is a different folder and invisible to an INBOX-only poller.
      const { listFolders } = await import("./imap");
      return Response.json(
        await listFolders(env.GMAIL_USER, env.GMAIL_APP_PASSWORD),
      );
    }

    if (url.pathname === "/poll" && request.method === "POST") {
      return Response.json(await ingest(env));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
