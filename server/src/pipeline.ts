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
import type { Pool } from "pg";
import { readNewMail, readMailboxMarkers, type FetchedMessage } from "./imap.ts";
import type { Storage } from "./storage.ts";
import type { Config } from "./config.ts";
// The one business-calendar service (docs/engineering-standards.md). Imported
// from the prototype package rather than copied: two implementations of the
// deadline rules would drift, and the UI would eventually show a different
// deadline from the one the system enforces.
import {
  responseDeadline,
  addWorkingHours,
  RESPONSE_HOURS,
} from "../../prototype/src/domain/business-calendar.ts";
import { chooseAssignee } from "./assignment.ts";
import { isApprovedSender, extractAddress } from "./domain.ts";
import {
  readCheckpoint,
  writeCheckpoint,
  alreadyIngested,
  createTicket,
  recordSkip,
  staffWorkloads,
  lastAssignee,
  findTicketByMessageIds,
  appendReply,
  recordBounce,
  claimNextIntent,
  recordAcceptance,
  recordSendFailure,
  sweepStaleSending,
} from "./store.ts";
import { buildAcknowledgement } from "./acknowledgement.ts";
import { buildReply } from "./reply.ts";
import { threadCandidates } from "./threading.ts";
import { isAutomaticMessage } from "./autoreply.ts";
import { isBounce, bouncedMessageIds } from "./bounce.ts";
import { parseOutgoingMessage } from "./mime.ts";
import { sendMessage, SmtpError } from "./smtp.ts";
import { buildNotification, type NotificationKind } from "./notification.ts";
import {
  addAttachment,
  enqueueIntent,
  isNotificationThread,
  ticketsNeedingReminder,
  ticketsReadyToClose,
  threadIds,
  addReply,
  recordReminder,
  staffEmail,
  adminEmails,
  getTicket,
} from "./store.ts";
import { classifySmtpFailure, nextAttemptAt, isAbandoned, SENDING_TIMEOUT_MS } from "./outbox.ts";

/**
 * Everything the pipeline needs, passed in rather than imported.
 *
 * This was `Env` — Cloudflare's injected bindings object. It is an ordinary
 * argument now, which is why the integration tests can run the whole pipeline
 * against a scratch database without a runtime to emulate.
 */
export interface AppContext {
  pool: Pool;
  storage: Storage;
  config: Config;
}

/**
 * Archive the raw message, returning its path for the ingest log.
 *
 * Never allowed to fail the ingest: a full disk must not stop tickets being
 * opened. The path is simply null when the archive did not happen, so the
 * database never claims a file that is not there.
 */
async function archive(env: AppContext, message: FetchedMessage): Promise<string | null> {
  if (message.source === null) return null;
  try {
    return await env.storage.storeRawMessage(message.uid, message.source);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "archive_failed", uid: message.uid, error: String(error) }),
    );
    return null;
  }
}

/**
 * Write a message's attachments to disk and index them (R12).
 *
 * Also never fatal: the ticket and its text matter more than its files, and an
 * attachment that failed to store is recoverable from the archived raw message.
 */
async function saveAttachments(
  env: AppContext,
  ticketId: number,
  message: FetchedMessage,
): Promise<number> {
  let stored = 0;
  for (const attachment of message.attachments) {
    try {
      const path = await env.storage.storeAttachment(ticketId, attachment.content);
      await addAttachment(env.pool, {
        ticketId,
        messageId: null,
        filename: attachment.filename,
        contentType: attachment.contentType,
        bytes: attachment.content.length,
        path,
      });
      stored += 1;
    } catch (error) {
      console.error(
        JSON.stringify({ event: "attachment_failed", ticket: ticketId, error: String(error) }),
      );
    }
  }
  return stored;
}

/**
 * Queue a one-way notification to a staff member (R15).
 *
 * Silently does nothing when there is nobody to tell - an unassigned ticket, or
 * a staff row with no address. That is the correct outcome, not an error: a
 * ticket with no owner has no assignee to notify, and the queue view already
 * shows it as unassigned.
 */
async function notify(
  env: AppContext,
  kind: NotificationKind,
  ticket: { id: number; subject: string; requester: string },
  recipient: string | null,
  extra: { minutesOverdue?: number } = {},
): Promise<boolean> {
  if (recipient === null || recipient === "") return false;
  const message = buildNotification({
    kind,
    ticketNumber: ticket.id,
    ticketSubject: ticket.subject,
    requester: ticket.requester,
    supportAddress: `SimpleTickets <${env.config.supportAddress}>`,
    dashboardUrl: env.config.dashboardUrl,
    recipient,
    date: new Date(),
    ...extra,
  });
  // The return value matters: a suppressed duplicate is not a notification
  // sent, and counting it as one would report reminders nobody received.
  return enqueueIntent(env.pool, {
    ticketId: ticket.id,
    intent: "notification",
    recipient,
    messageId: message.messageId,
    payload: JSON.stringify(message),
  });
}

/** Tell a ticket's assignee something happened on it. */
export async function notifyAssignee(
  env: AppContext,
  ticketId: number,
  kind: NotificationKind,
  extra: { minutesOverdue?: number } = {},
): Promise<boolean> {
  const detail = await getTicket(env.pool, ticketId);
  if (detail === null || detail.ticket.owner === null) return false;
  return notify(env, kind, detail.ticket, await staffEmail(env.pool, detail.ticket.owner), extra);
}

export interface RunSummary {
  initialised?: boolean;
  uidValidityChanged?: boolean;
  examined: number;
  created: number;
  appended: number;
  autoReplies: number;
  notificationReplies: number;
  bounces: number;
  rejected: number;
  skipped: number;
  attachments: number;
  lastUid: number;
}

export async function ingest(env: AppContext): Promise<RunSummary> {
  const existing = await readCheckpoint(env.pool);

  // First run: adopt the mailbox as-is and import nothing (R27).
  if (existing === null) {
    const probe = await readMailboxMarkers(env.config.gmailUser, env.config.gmailAppPassword);
    await writeCheckpoint(env.pool, {
      uidValidity: probe.uidValidity,
      lastUid: probe.uidNext - 1,
    });
    return {
      initialised: true,
      examined: 0,
      created: 0,
      appended: 0,
      autoReplies: 0,
      notificationReplies: 0,
      bounces: 0,
      rejected: 0,
      skipped: 0,
      attachments: 0,
      lastUid: probe.uidNext - 1,
    };
  }

  const read = await readNewMail(
    env.config.gmailUser,
    env.config.gmailAppPassword,
    existing.lastUid,
  );

  // UIDVALIDITY changing means the server has renumbered every message, so the
  // stored UID means nothing any more. Re-anchor to the current uidNext rather
  // than re-importing the mailbox; ingest_log still prevents duplicates for
  // anything already seen.
  if (read.uidValidity !== existing.uidValidity) {
    await writeCheckpoint(env.pool, {
      uidValidity: read.uidValidity,
      lastUid: read.uidNext - 1,
    });
    return {
      uidValidityChanged: true,
      examined: 0,
      created: 0,
      appended: 0,
      autoReplies: 0,
      notificationReplies: 0,
      bounces: 0,
      rejected: 0,
      skipped: 0,
      attachments: 0,
      lastUid: read.uidNext - 1,
    };
  }

  let created = 0;
  let appended = 0;
  let autoReplies = 0;
  let notificationReplies = 0;
  let bounces = 0;
  let rejected = 0;
  let skipped = 0;
  let attachments = 0;
  let highest = existing.lastUid;

  for (const message of read.messages) {
    highest = Math.max(highest, message.uid);

    if (await alreadyIngested(env.pool, message.uid)) {
      skipped += 1;
      continue;
    }

    // R01. Note this authorises, it does not authenticate: the constitution is
    // explicit that a matching domain is not proof of who sent the message.
    if (!isApprovedSender(message.from)) {
      await recordSkip(
        env.pool,
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
        env.pool,
        bouncedMessageIds(`${message.rawHeaders}\n${message.body}`),
      );
      await recordSkip(
        env.pool,
        message.uid,
        "bounce",
        ticketId === null
          ? "Delivery failure; no matching sent message"
          : `Delivery failure for ticket ${String(ticketId)}`,
      );
      if (ticketId !== null) await notifyAssignee(env, ticketId, "delivery_failed");
      bounces += 1;
      continue;
    }

    // R15: a staff member replying to a one-way notification. They are on the
    // approved domain, so nothing earlier catches this. Checked BEFORE
    // threading, because the notification's Message-ID is deliberately not
    // threadable and the reply would otherwise open a brand new ticket
    // containing a quoted notification.
    const candidates = threadCandidates(message.inReplyTo, message.references);
    if (await isNotificationThread(env.pool, candidates)) {
      await recordSkip(
        env.pool,
        message.uid,
        "notification_reply",
        "Reply to a one-way IT notification; not added to the ticket",
      );
      notificationReplies += 1;
      continue;
    }

    // An out-of-office answering our acknowledgement is not an employee reply.
    // Threading it onto the ticket would restart the response clock and reopen
    // a Resolved ticket, every time it fired.
    if (isAutomaticMessage(message.rawHeaders)) {
      await recordSkip(env.pool, message.uid, "auto_reply", "Automatic message; not a reply");
      autoReplies += 1;
      continue;
    }

    const requester = extractAddress(message.from);
    if (requester === null) {
      await recordSkip(env.pool, message.uid, "error", "Could not parse sender address");
      rejected += 1;
      continue;
    }

    // A reply joins its existing ticket instead of opening another. Without
    // this, every answer to our own acknowledgement would open a second ticket.
    // Matching is on Message-ID headers only: the specification is explicit
    // that knowing a ticket number is not enough to join a conversation.
    const existingTicket = await findTicketByMessageIds(env.pool, candidates);
    if (existingTicket !== null) {
      await appendReply(env.pool, {
        ticketId: existingTicket,
        uid: message.uid,
        author: requester,
        body: message.body,
        messageId: message.messageId,
        rawPath: await archive(env, message),
      });
      attachments += await saveAttachments(env, existingTicket, message);
      // R15: the assignee is told about an employee reply. Queued, never sent
      // inline - the same reason the acknowledgement is queued.
      await notifyAssignee(env, existingTicket, "employee_reply");
      appended += 1;
      continue;
    }

    const rawPath = await archive(env, message);
    const ticketId = await createTicket(
      env.pool,
      {
        uid: message.uid,
        rawPath,
        subject: message.subject,
        requester,
        body: message.body,
        messageId: message.messageId,
        // R03: four working hours, Mon-Sat 09:00-18:00 Asia/Kolkata, with a
        // Sunday arrival due Monday noon. Anchored to when WE received it, not
        // to the Date header, which the sender controls.
        responseDue: responseDeadline(new Date()).toISOString(),
        // R07: fewest open tickets, round robin for ties. null when nobody is
        // available - the ticket stays visibly unassigned rather than being
        // handed to someone who cannot work it.
        owner: chooseAssignee(
          (await staffWorkloads(env.pool)).map((member) => ({
            name: member.name,
            openTickets: member.openTickets,
            available: member.available,
          })),
          await lastAssignee(env.pool),
        ),
      },
      // R02: the acknowledgement is queued, never sent inline. Sending here
      // would put an SMTP round trip inside the ingestion loop, where a slow
      // or refusing server would stall every remaining email.
      (ticketId) => {
        const ack = buildAcknowledgement({
          ticketNumber: ticketId,
          originalSubject: message.subject,
          requester,
          supportAddress: `SimpleTickets <${env.config.gmailUser}>`,
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
    attachments += await saveAttachments(env, ticketId, message);
    // R15: notify on assignment. Only fires when chooseAssignee found somebody.
    await notifyAssignee(env, ticketId, "assigned");
    created += 1;
  }

  // Advance only after processing, so a crash mid-run re-examines rather than
  // skips. ingest_log makes re-examination harmless.
  if (highest > existing.lastUid) {
    await writeCheckpoint(env.pool, { uidValidity: read.uidValidity, lastUid: highest });
  }

  return {
    examined: read.messages.length,
    created,
    appended,
    autoReplies,
    notificationReplies,
    bounces,
    rejected,
    skipped,
    attachments,
    lastUid: highest,
  };
}

/**
 * Overdue reminders (R18): to the assignee and every admin, repeating every
 * four working hours until IT replies.
 *
 * Business time, not elapsed time. Four working hours from Saturday afternoon
 * is Monday morning, and a reminder that fired every four *clock* hours would
 * send four of them overnight to nobody reading.
 */
export async function sendReminders(env: AppContext, now: Date = new Date()): Promise<number> {
  let sent = 0;
  for (const ticket of await ticketsNeedingReminder(env.pool, now)) {
    // The first reminder is due at the deadline itself; later ones four
    // working hours after the last.
    const dueAt =
      ticket.last_reminder_at === null
        ? new Date(ticket.response_due)
        : addWorkingHours(new Date(ticket.last_reminder_at), RESPONSE_HOURS);
    if (Number.isNaN(dueAt.getTime()) || dueAt > now) continue;

    const minutesOverdue = Math.max(
      0,
      Math.floor((now.getTime() - Date.parse(ticket.response_due)) / 60_000),
    );
    const recipients = new Set<string>(await adminEmails(env.pool));
    if (ticket.owner !== null) {
      const owner = await staffEmail(env.pool, ticket.owner);
      if (owner !== null) recipients.add(owner);
    }
    for (const recipient of recipients) {
      if (await notify(env, "overdue", ticket, recipient, { minutesOverdue })) sent += 1;
    }
    // Recorded even when nobody could be reached, so an unassigned ticket with
    // no admin address does not re-run this every two minutes forever.
    await recordReminder(env.pool, ticket.id, now.toISOString());
  }
  return sent;
}

/** R19: 72 elapsed hours, including Sundays and holidays. */
export const AUTO_CLOSE_HOURS = 72;

/**
 * Close Resolved tickets the employee has not come back on (R19).
 *
 * Elapsed hours, deliberately not working hours: R19 says "including Sundays
 * and holidays". The response deadline is business time because it is a promise
 * about how fast a person will answer; this is just a quiet period.
 *
 * The closure is QUEUED, not applied. R19 and R28 both say a ticket stays
 * Resolved until the closure email is accepted, so the transition rides on the
 * outbox row as pendingStatus and recordAcceptance applies it - the same
 * machinery a manual closure uses, because they must behave identically.
 */
export async function autoClose(env: AppContext, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AUTO_CLOSE_HOURS * 3_600_000).toISOString();
  let queued = 0;

  for (const ticket of await ticketsReadyToClose(env.pool, cutoff)) {
    const message = buildReply({
      ticketNumber: ticket.id,
      ticketSubject: ticket.subject,
      requester: ticket.requester,
      supportAddress: `SimpleTickets <${env.config.supportAddress}>`,
      body: [
        `We are closing ticket #${String(ticket.id)}.`,
        "",
        `It was marked resolved ${String(AUTO_CLOSE_HOURS)} hours ago and we have not heard`,
        "back, so we are assuming it is sorted.",
        "",
        "If it is not, reply to this email and the ticket reopens - you do not",
        "need to start a new request.",
      ].join("\n"),
      threadMessageIds: await threadIds(env.pool, ticket.id),
      date: now,
    });

    await addReply(env.pool, {
      ticketId: ticket.id,
      // Not a staff member: nobody pressed anything. Attributing an automatic
      // action to a person would put a fiction in the audit trail.
      author: "system",
      body: message.body,
      messageId: message.messageId,
      recipient: ticket.requester,
      payload: JSON.stringify(message),
      intent: "closure",
      pendingStatus: "Closed",
    });
    queued += 1;
  }
  return queued;
}

export interface FlushSummary {
  sent: number;
  deferred: number;
  failed: number;
  parked: number;
  /** True when MAIL_SEND was off, so nothing was put on the wire. */
  held?: boolean;
}

/**
 * Send what is due. Separate from ingestion on purpose: mail that cannot go out
 * must never block mail coming in, and a refusing SMTP server should slow
 * replies, not stop tickets being opened.
 *
 * Bounded per run so one run cannot exhaust the CPU budget on a long backlog;
 * the next run picks up the rest.
 */
export async function flushOutbox(env: AppContext, limit = 5): Promise<FlushSummary> {
  // Sends whose outcome we never learned are parked first, so a row stuck from
  // an earlier run cannot sit in 'sending' forever and block its ticket.
  const parked = await sweepStaleSending(env.pool, new Date(), SENDING_TIMEOUT_MS);

  // The send gate. Intents are still enqueued, claimed and rendered when this
  // is off - everything except the wire. It is off by default because the
  // usual reason to run this locally is to develop against the real mailbox,
  // and a second acknowledgement for a ticket the deployed system already
  // answered lands in a real employee's inbox.
  if (!env.config.mailSend) {
    return { sent: 0, deferred: 0, failed: 0, parked, held: true };
  }

  let sent = 0;
  let deferred = 0;
  let failed = 0;

  for (let i = 0; i < limit; i += 1) {
    const due = await claimNextIntent(env.pool, new Date());
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
          env.pool,
          due.id,
          "failed",
          new Date().toISOString(),
          `Unsendable payload: ${detail}`,
        );
        failed += 1;
        continue;
      }

      const acceptance = await sendMessage({
        user: env.config.gmailUser,
        appPassword: env.config.gmailAppPassword,
        message,
        envelopeFrom: env.config.gmailUser,
        envelopeTo: [due.recipient],
      });
      // R28: the acceptance and any status transition waiting on it commit
      // together.
      await recordAcceptance(
        env.pool,
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
        await recordSendFailure(env.pool, due.id, "failed", new Date().toISOString(), detail);
        failed += 1;
      } else {
        await recordSendFailure(
          env.pool,
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
