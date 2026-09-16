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
  findTicketByMessageIds,
  appendReply,
  recordBounce,
  outboxSummary,
  claimNextIntent,
  recordAcceptance,
  recordSendFailure,
  sweepStaleSending,
} from "./store";
import { buildAcknowledgement } from "./acknowledgement";
import { threadCandidates } from "./threading";
import { isAutomaticMessage } from "./autoreply";
import { isBounce, bouncedMessageIds } from "./bounce";
import { parseOutgoingMessage } from "./mime";
import { sendMessage } from "./smtp-transport";
import { SmtpError } from "./smtp";
import { isAuthorised } from "./auth";
import { classifySmtpFailure, nextAttemptAt, isAbandoned, SENDING_TIMEOUT_MS } from "./outbox";

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
  appended: number;
  autoReplies: number;
  bounces: number;
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
      appended: 0,
      autoReplies: 0,
      bounces: 0,
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
      appended: 0,
      autoReplies: 0,
      bounces: 0,
      rejected: 0,
      skipped: 0,
      lastUid: read.uidNext - 1,
    };
  }

  let created = 0;
  let appended = 0;
  let autoReplies = 0;
  let bounces = 0;
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
      await recordSkip(
        env.DB,
        message.uid,
        "rejected_sender",
        "Sender outside the approved domain",
      );
      rejected += 1;
      continue;
    }

    // Bounces are checked BEFORE auto-replies. A bounce has a null return path,
    // so the auto-reply test matches it too - and filing a delivery failure as
    // an out-of-office would lose it, when R15 needs it visible and R28 needs it
    // to pause auto-close.
    if (isBounce(message.rawHeaders)) {
      const ticketId = await recordBounce(
        env.DB,
        bouncedMessageIds(`${message.rawHeaders}\n${message.body}`),
      );
      await recordSkip(
        env.DB,
        message.uid,
        "bounce",
        ticketId === null
          ? "Delivery failure; no matching sent message"
          : `Delivery failure for ticket ${String(ticketId)}`,
      );
      bounces += 1;
      continue;
    }

    // An out-of-office answering our acknowledgement is not an employee reply.
    // Threading it onto the ticket would restart the response clock and reopen
    // a Resolved ticket, every time it fired.
    if (isAutomaticMessage(message.rawHeaders)) {
      await recordSkip(env.DB, message.uid, "auto_reply", "Automatic message; not a reply");
      autoReplies += 1;
      continue;
    }

    const requester = extractAddress(message.from);
    if (requester === null) {
      await recordSkip(env.DB, message.uid, "error", "Could not parse sender address");
      rejected += 1;
      continue;
    }

    // A reply joins its existing ticket instead of opening another. Without
    // this, every answer to our own acknowledgement would open a second ticket.
    // Matching is on Message-ID headers only: the specification is explicit
    // that knowing a ticket number is not enough to join a conversation.
    const existingTicket = await findTicketByMessageIds(
      env.DB,
      threadCandidates(message.inReplyTo, message.references),
    );
    if (existingTicket !== null) {
      await appendReply(env.DB, {
        ticketId: existingTicket,
        uid: message.uid,
        author: requester,
        body: message.body,
        messageId: message.messageId,
      });
      appended += 1;
      continue;
    }

    await createTicket(
      env.DB,
      {
        uid: message.uid,
        subject: message.subject,
        requester,
        body: message.body,
        messageId: message.messageId,
      },
      // R02: the acknowledgement is queued, never sent inline. Sending here
      // would put an SMTP round trip inside the ingestion loop, where a slow
      // or refusing server would stall every remaining email.
      (ticketId) => {
        const ack = buildAcknowledgement({
          ticketNumber: ticketId,
          originalSubject: message.subject,
          requester,
          supportAddress: `SimpleTickets <${env.GMAIL_USER}>`,
          inboundMessageId: message.messageId,
          date: new Date(),
        });
        return {
          ticketId,
          intent: "acknowledgement",
          recipient: requester,
          messageId: ack.messageId,
          payload: JSON.stringify(ack),
        };
      },
    );
    created += 1;
  }

  // Advance only after processing, so a crash mid-run re-examines rather than
  // skips. ingest_log makes re-examination harmless.
  if (highest > existing.lastUid) {
    await writeCheckpoint(env.DB, { uidValidity: read.uidValidity, lastUid: highest });
  }

  return {
    examined: read.messages.length,
    created,
    appended,
    autoReplies,
    bounces,
    rejected,
    skipped,
    lastUid: highest,
  };
}

interface FlushSummary {
  sent: number;
  deferred: number;
  failed: number;
  parked: number;
}

/**
 * Send what is due. Separate from ingestion on purpose: mail that cannot go out
 * must never block mail coming in, and a refusing SMTP server should slow
 * replies, not stop tickets being opened.
 *
 * Bounded per run so one run cannot exhaust the CPU budget on a long backlog;
 * the next run picks up the rest.
 */
async function flushOutbox(env: Env, limit = 5): Promise<FlushSummary> {
  // Sends whose outcome we never learned are parked first, so a row stuck from
  // an earlier run cannot sit in 'sending' forever and block its ticket.
  const parked = await sweepStaleSending(env.DB, new Date(), SENDING_TIMEOUT_MS);
  let sent = 0;
  let deferred = 0;
  let failed = 0;

  for (let i = 0; i < limit; i += 1) {
    const due = await claimNextIntent(env.DB, new Date());
    if (due === null) break;

    try {
      // Parsed before the socket is opened, and separately from it: a row whose
      // payload will not parse can never be sent, so it must fail immediately
      // rather than burn five backed-off retries discovering that.
      let message;
      try {
        message = parseOutgoingMessage(due.payload);
      } catch (parseError) {
        const detail = parseError instanceof Error ? parseError.message : String(parseError);
        await recordSendFailure(
          env.DB,
          due.id,
          "failed",
          new Date().toISOString(),
          `Unsendable payload: ${detail}`,
        );
        failed += 1;
        continue;
      }

      const acceptance = await sendMessage({
        user: env.GMAIL_USER,
        appPassword: env.GMAIL_APP_PASSWORD,
        message,
        envelopeFrom: env.GMAIL_USER,
        envelopeTo: [due.recipient],
      });
      // R28: the acceptance and any status transition waiting on it commit
      // together.
      await recordAcceptance(
        env.DB,
        due.id,
        due.ticketId,
        acceptance.acceptedAt,
        acceptance.reply,
        due.pendingStatus,
      );
      sent += 1;
    } catch (error) {
      const code = error instanceof SmtpError ? error.code : "";
      const permanent = classifySmtpFailure(code) === "permanent";
      const exhausted = isAbandoned(due.attempts);
      const detail = error instanceof Error ? error.message : String(error);

      if (permanent || exhausted) {
        await recordSendFailure(env.DB, due.id, "failed", new Date().toISOString(), detail);
        failed += 1;
      } else {
        await recordSendFailure(
          env.DB,
          due.id,
          "pending",
          nextAttemptAt(due.attempts, new Date()),
          detail,
        );
        deferred += 1;
      }
    }
  }

  return { sent, deferred, failed, parked };
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const summary = await ingest(env);
    const outbox = await flushOutbox(env);
    // Counts only: subjects and addresses stay out of the logs.
    console.log(JSON.stringify({ source: "cron", ...summary, outbox }));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorised(env.ADMIN_TOKEN, request.headers.get("x-admin-token"))) {
      // 404 rather than 401: the routes do not announce that they exist.
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
      return Response.json({ checkpoint, counts, outbox: await outboxSummary(env.DB) });
    }

    if (url.pathname === "/diag") {
      // Where did the mail actually land? Gmail files unknown senders in Spam,
      // which is a different folder and invisible to an INBOX-only poller.
      const { listFolders } = await import("./imap");
      return Response.json(await listFolders(env.GMAIL_USER, env.GMAIL_APP_PASSWORD));
    }

    if (url.pathname === "/poll" && request.method === "POST") {
      const summary = await ingest(env);
      return Response.json({ ...summary, outbox: await flushOutbox(env) });
    }

    // Send only, without reading mail. Useful when ingestion is fine and the
    // outbox has a backlog to work through.
    if (url.pathname === "/flush" && request.method === "POST") {
      return Response.json(await flushOutbox(env));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
