/**
 * The dashboard API.
 *
 * Split out of index.ts because it had grown past the point where the routing
 * was readable, and because these routes share one concern the operational ones
 * do not: they are called from a browser, so every response needs CORS.
 * Attaching that once at this boundary is safer than at each return, which is
 * how one endpoint silently ends up unreachable.
 */
import {
  listTickets,
  getTicket,
  threadIds,
  addReply,
  addNote,
  staffWorkloads,
  addStaff,
  setAvailability,
  setStatus,
} from "./store";
import { buildReply } from "./reply";
import { transitionRule, STATUSES, type Status } from "./transitions";
import { responseState } from "./overdue";
import { hashPassword, verifyPassword, TOTAL_ITERATIONS, ROUNDS } from "./password";
import type { Env } from "./pipeline";

export async function handleApi(url: URL, request: Request, env: Env): Promise<Response> {
  // ---- dashboard API ----------------------------------------------------
  // Everything here is behind the same single admin token as the operational
  // routes. That is NOT multi-user authentication: there is one shared
  // secret, so the API cannot tell one staff member from another and nothing
  // here may be treated as an audit trail of who did what. Real per-staff
  // sign-in is R06, still blocked on the Workers PBKDF2 cap.

  if (url.pathname === "/api/staff") {
    if (request.method === "GET") {
      return Response.json({ staff: await staffWorkloads(env.DB) });
    }
    if (request.method === "POST") {
      const raw: unknown = await request.json().catch(() => null);
      const payload: Record<string, unknown> =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const name = payload["name"];
      if (typeof name !== "string" || name.trim().length === 0) {
        return Response.json({ error: "A name is required" }, { status: 400 });
      }
      const email = typeof payload["email"] === "string" ? payload["email"] : null;

      // Availability is admin-controlled and distinct from account access:
      // marking someone unavailable stops new work reaching them without
      // revoking anything (R24).
      if ("available" in payload) {
        const changed = await setAvailability(env.DB, name, payload["available"] === true);
        if (!changed) {
          return Response.json({ error: "No such staff member" }, { status: 404 });
        }
        return Response.json({ updated: name, available: payload["available"] === true });
      }

      await addStaff(env.DB, name, email);
      return Response.json({ added: name });
    }
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (url.pathname === "/api/tickets" && request.method === "GET") {
    const now = new Date();
    const tickets = (await listTickets(env.DB)).map((ticket) => ({
      ...ticket,
      ...responseState(ticket.response_due, ticket.first_response_at, ticket.status, now),
    }));

    // A queue summary, because the first question anyone asks is "what needs
    // attention" and counting rows by hand in a UI is how that gets answered
    // wrongly.
    const byStatus: Record<string, number> = {};
    for (const ticket of tickets) {
      byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
    }
    return Response.json({
      summary: {
        total: tickets.length,
        overdue: tickets.filter((ticket) => ticket.overdue).length,
        unassigned: tickets.filter((ticket) => ticket.owner === null).length,
        awaitingFirstResponse: tickets.filter((ticket) => !ticket.met).length,
        byStatus,
      },
      tickets,
    });
  }

  const ticketMatch = /^\/api\/tickets\/(\d+)(\/reply|\/note|\/status)?$/.exec(url.pathname);
  if (ticketMatch !== null) {
    const id = Number(ticketMatch[1]);
    const detail = await getTicket(env.DB, id);
    if (detail === null) {
      return Response.json({ error: "No such ticket" }, { status: 404 });
    }

    if (request.method === "GET" && ticketMatch[2] === undefined) {
      return Response.json({
        ...detail,
        ticket: {
          ...detail.ticket,
          ...responseState(
            detail.ticket.response_due,
            detail.ticket.first_response_at,
            detail.ticket.status,
            new Date(),
          ),
        },
      });
    }

    if (request.method === "POST") {
      // Request bodies are an external boundary: validate, never cast.
      const raw: unknown = await request.json().catch(() => null);
      const payload: Record<string, unknown> =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const body = payload["body"];
      if (typeof body !== "string" || body.trim().length === 0) {
        return Response.json({ error: "A body is required" }, { status: 400 });
      }
      const author = typeof payload["author"] === "string" ? payload["author"] : "IT";

      // An internal note never touches the outbox. See store.addNote.
      if (ticketMatch[2] === "/note") {
        await addNote(env.DB, id, author, body);
        return Response.json({ added: "note" });
      }

      if (ticketMatch[2] === "/status") {
        const target = payload["status"];
        if (typeof target !== "string" || !STATUSES.includes(target as Status)) {
          return Response.json(
            { error: `status must be one of: ${STATUSES.join(", ")}` },
            { status: 400 },
          );
        }
        const rule = transitionRule(detail.ticket.status as Status, target as Status);

        if (rule.kind === "invalid") {
          return Response.json({ error: rule.reason }, { status: 409 });
        }

        if (rule.kind === "immediate") {
          await setStatus(env.DB, id, target);
          return Response.json({ status: target, applied: "immediately" });
        }

        // R28: queue the message that justifies the change and hang the
        // transition off it. The status does not move until the server
        // accepts - recordAcceptance applies both in one batch.
        const message = buildReply({
          ticketNumber: id,
          ticketSubject: detail.ticket.subject,
          requester: detail.ticket.requester,
          supportAddress: `SimpleTickets <${env.GMAIL_USER}>`,
          body,
          threadMessageIds: await threadIds(env.DB, id),
          date: new Date(),
        });
        await addReply(env.DB, {
          ticketId: id,
          author,
          body,
          messageId: message.messageId,
          recipient: detail.ticket.requester,
          payload: JSON.stringify(message),
          intent: rule.intent,
          pendingStatus: target,
        });
        return Response.json({
          queued: true,
          intent: rule.intent,
          pendingStatus: target,
          note: "Status changes when the mail server accepts this message (R28).",
        });
      }

      if (ticketMatch[2] === "/reply") {
        const message = buildReply({
          ticketNumber: id,
          ticketSubject: detail.ticket.subject,
          requester: detail.ticket.requester,
          supportAddress: `SimpleTickets <${env.GMAIL_USER}>`,
          body,
          threadMessageIds: await threadIds(env.DB, id),
          date: new Date(),
        });
        await addReply(env.DB, {
          ticketId: id,
          author,
          body,
          messageId: message.messageId,
          recipient: detail.ticket.requester,
          payload: JSON.stringify(message),
        });
        // Queued, not sent. The ticker delivers it on its next tick, so a
        // slow or refusing SMTP server cannot block the dashboard.
        return Response.json({ queued: true, messageId: message.messageId });
      }
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Proves the password KDF works on THIS runtime with these parameters, and
  // reports what it costs. Workers caps a single PBKDF2 call at 100,000
  // iterations, so the chained scheme has to be measured here rather than
  // trusted because it passed under Node. Hashes a throwaway random string; no
  // real password is involved.
  if (url.pathname === "/api/kdf-selftest") {
    const sample = crypto.randomUUID();
    const started = Date.now();
    const stored = await hashPassword(sample);
    const hashedMs = Date.now() - started;

    const verifyStarted = Date.now();
    const accepted = await verifyPassword(sample, stored);
    const rejected = await verifyPassword(`${sample}x`, stored);
    const verifyMs = Date.now() - verifyStarted;

    return Response.json({
      scheme: stored.split("$")[0],
      rounds: ROUNDS,
      totalIterations: TOTAL_ITERATIONS,
      hashedMs,
      verifyMs,
      correctAccepted: accepted,
      wrongRejected: !rejected,
      ok: accepted && !rejected,
    });
  }

  return Response.json({ error: "No such endpoint" }, { status: 404 });
}
