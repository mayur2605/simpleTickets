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
import { isApprovedSender, extractAddress, eligibleParticipants } from "./domain.ts";
import { buildAcknowledgement } from "./acknowledgement.ts";
import { buildReply } from "./reply.ts";
import { threadCandidates } from "./threading.ts";
import { isAutomaticMessage } from "./autoreply.ts";
import { isBounce, bouncedMessageIds } from "./bounce.ts";
import { parseOutgoingMessage } from "./mime.ts";
import { sendMessage, SmtpError } from "./smtp.ts";
import { buildNotification, type NotificationKind } from "./notification.ts";
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
  addAttachment,
  enqueueIntent,
  isNotificationThread,
  addParticipants,
  listParticipants,
  isTicketParticipant,
  claimOversizedNotice,
  assignable,
  recordAudit,
  setOwner,
  unassignedOpenTickets,
  withAssignmentLock,
  ticketsNeedingReminder,
  ticketsReadyToClose,
  threadIds,
  addReply,
  recordReminder,
  staffEmail,
  adminEmails,
  getTicket,
} from "./store.ts";
import { MAX_ATTACHMENT_BYTES } from "./storage.ts";
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
 * Tell the employee their attachments did not fit (R12).
 *
 * Queued as an intent with no `messages` row, exactly as the acknowledgement
 * is. That is not an oversight: `first_response_at` is the earliest outbound
 * message, so writing this to the history would have an automatic size notice
 * satisfy the four-hour response deadline (R03) - IT would have "answered"
 * without answering.
 *
 * Sent once per ticket. `claimOversizedNotice` is the lock: it returns true to
 * exactly one caller, so two attachments refused in the same email produce one
 * email back, not two.
 */
async function noticeOversized(
  env: AppContext,
  ticket: { id: number; subject: string; requester: string },
  refused: readonly string[],
): Promise<boolean> {
  if (refused.length === 0) return false;
  if (!(await claimOversizedNotice(env.pool, ticket.id))) return false;

  const megabytes = String(Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024)));
  const message = buildReply({
    ticketNumber: ticket.id,
    ticketSubject: ticket.subject,
    requester: ticket.requester,
    supportAddress: `SimpleTickets <${env.config.supportAddress}>`,
    body: [
      `We received your message and opened ticket #${String(ticket.id)}, but some`,
      `of the attached files were too large. We accept ${megabytes} MB of`,
      "attachments per email in total.",
      "",
      "These did not arrive:",
      ...refused.map((name) => `  - ${name}`),
      "",
      "Please reply with them one or two at a time, or send a link instead.",
      "Everything you wrote has been saved to the ticket.",
    ].join("\n"),
    threadMessageIds: await threadIds(env.pool, ticket.id),
    date: new Date(),
  });
  return enqueueIntent(env.pool, {
    ticketId: ticket.id,
    intent: "reply",
    recipient: ticket.requester,
    messageId: message.messageId,
    payload: JSON.stringify(message),
  });
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

/**
 * Choose an owner and set it, under the assignment lock (R07).
 *
 * The read of workloads, the choice and the write happen inside one
 * transaction, so two of these deciding at once cannot both pick the same
 * least-loaded person. `exclude` is for redistribution: the person being moved
 * away from must not win their own tickets back.
 *
 * Returns the chosen owner, or null when nobody qualifies.
 */
export async function assignTicket(
  env: AppContext,
  ticketId: number,
  actor = "system",
  exclude?: string,
): Promise<string | null> {
  return withAssignmentLock(env.pool, async (db) => {
    const candidates = assignable(await staffWorkloads(db)).filter(
      (member) => member.name !== exclude,
    );
    const owner = chooseAssignee(candidates, await lastAssignee(db));
    await setOwner(db, ticketId, owner, actor);
    return owner;
  });
}

/** Tell every admin something about a ticket nobody owns (R24). */
export async function notifyAdmins(
  env: AppContext,
  ticket: { id: number; subject: string; requester: string },
  kind: NotificationKind,
): Promise<number> {
  let sent = 0;
  for (const address of await adminEmails(env.pool)) {
    if (await notify(env, kind, ticket, address)) sent += 1;
  }
  return sent;
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
      // The COMPLETE source, not headers-plus-body. The original message is in
      // the report's message/rfc822 part, which readBody never returns - so for
      // as long as this passed the extracted body, detection worked and
      // matching almost never did. Falls back to what we have if the archive
      // was not fetched.
      const raw =
        message.source === null
          ? `${message.rawHeaders}\n${message.body}`
          : message.source.toString("utf8");
      const ticketId = await recordBounce(env.pool, bouncedMessageIds(raw));
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
      // R25: being on the approved domain authorises opening a ticket of your
      // own. It does not authorise writing into a colleague's. Without this
      // check, anybody in the company who learned a Message-ID could join any
      // conversation - and IT would see their message attributed as the
      // employee's own reply.
      if (!(await isTicketParticipant(env.pool, existingTicket, requester))) {
        await recordSkip(
          env.pool,
          message.uid,
          "not_a_participant",
          `Sender is not on ticket ${String(existingTicket)}; not appended`,
        );
        await recordAudit(env.pool, {
          ticketId: existingTicket,
          actor: "system",
          action: "reply_refused",
          detail: `${requester} is not a participant`,
        });
        rejected += 1;
        continue;
      }

      const detail = await getTicket(env.pool, existingTicket);
      await appendReply(env.pool, {
        ticketId: existingTicket,
        uid: message.uid,
        author: requester,
        body: message.body,
        messageId: message.messageId,
        rawPath: await archive(env, message),
        // R16: a new response episode, if IT has answered since the employee
        // last wrote. Anchored to when WE received it, like the first one, and
        // applied only if this actually opens an episode - appendReply decides,
        // because only the database knows whether a response is already owed.
        responseDue: responseDeadline(new Date()).toISOString(),
      });
      attachments += await saveAttachments(env, existingTicket, message);

      // R25: the REQUESTER may add colleagues by copying them on a reply.
      // Nobody else can - a participant who adds three more would grow the
      // audience of somebody else's IT conversation without anyone deciding to.
      if (detail !== null && requester === detail.ticket.requester.toLowerCase()) {
        await addParticipants(
          env.pool,
          existingTicket,
          eligibleParticipants(message.cc, [
            detail.ticket.requester,
            env.config.supportAddress,
            env.config.gmailUser,
          ]),
          "requester",
        );
      } else if (detail !== null) {
        const ignored = eligibleParticipants(message.cc, [
          detail.ticket.requester,
          env.config.supportAddress,
          env.config.gmailUser,
          ...(await listParticipants(env.pool, existingTicket)),
        ]);
        // Recorded rather than silently dropped: IT can add them deliberately
        // if the sender was right to try.
        if (ignored.length > 0) {
          await recordAudit(env.pool, {
            ticketId: existingTicket,
            actor: "system",
            action: "participant_addition_ignored",
            detail: `${requester} copied ${ignored.join(", ")}`,
          });
        }
      }
      if (detail !== null) {
        await noticeOversized(env, detail.ticket, message.oversized);
      }

      // R10: a reply reopens a Resolved or Closed ticket and keeps its owner -
      // but only if that owner can still work it. An account disabled since the
      // ticket was resolved would otherwise own a live conversation nobody is
      // reading, which is the failure redistribution exists to prevent.
      const reopened = await getTicket(env.pool, existingTicket);
      const owner = reopened?.ticket.owner ?? null;
      const canStillWork =
        owner !== null &&
        assignable(await staffWorkloads(env.pool)).some(
          (member) => member.name === owner && member.available,
        );
      if (!canStillWork) {
        if ((await assignTicket(env, existingTicket)) === null) {
          if (reopened !== null) await notifyAdmins(env, reopened.ticket, "unassigned");
        } else {
          await notifyAssignee(env, existingTicket, "assigned");
        }
      }

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
        // Assigned immediately below, under the assignment lock. Created
        // unowned rather than owned-on-insert so the choice and the write
        // happen inside one transaction with everything else deciding an
        // owner - two ingests running at once would otherwise both read the
        // same workloads and both pick the same person.
        owner: null,
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

    // R25: colleagues copied on the original email join the ticket, provided
    // they are on the approved domain. Our own addresses are excluded - copying
    // the support mailbox on a reply to the support mailbox is how a loop
    // starts.
    await addParticipants(
      env.pool,
      ticketId,
      eligibleParticipants(message.cc, [
        requester,
        env.config.supportAddress,
        env.config.gmailUser,
      ]),
      "requester",
    );

    const opened = { id: ticketId, subject: message.subject, requester };
    await noticeOversized(env, opened, message.oversized);

    // R07/R24: fewest open tickets, round robin for ties, and only among people
    // who are both available AND still have an account. null when nobody
    // qualifies - the ticket stays visibly unassigned rather than being handed
    // to someone who cannot work it, and every admin is told, because an
    // unassigned ticket has no assignee to remind and would otherwise sit
    // silently until its deadline passed.
    if ((await assignTicket(env, ticketId)) === null) {
      await notifyAdmins(env, opened, "unassigned");
    } else {
      await notifyAssignee(env, ticketId, "assigned");
    }
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
 * Give unassigned open tickets an owner (R24).
 *
 * Called when somebody becomes available again. It deliberately only touches
 * tickets with NO owner: R24 says restoring availability must not rebalance
 * work already assigned to people who are working it, and moving a ticket
 * somebody has started is how two people answer the same employee.
 *
 * Nor does it return the tickets that were taken off them. Redistribution
 * happened because they were unavailable; whoever picked those up has since
 * been answering the employee, and taking them back mid-conversation is worse
 * than leaving them where they are.
 */
export async function assignUnassigned(env: AppContext, actor = "system"): Promise<number> {
  let assigned = 0;
  for (const ticket of await unassignedOpenTickets(env.pool)) {
    if ((await assignTicket(env, ticket, actor)) === null) break;
    await notifyAssignee(env, ticket, "assigned");
    assigned += 1;
  }
  return assigned;
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
      participants: await listParticipants(env.pool, ticket.id),
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
        // R25: the Cc header alone delivers to nobody. SMTP routes by envelope,
        // and a copied colleague who is in the header but not in RCPT TO sees
        // their own name on a message they never received.
        envelopeTo: [due.recipient, ...(message.cc ?? [])],
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
