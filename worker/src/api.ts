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
import {
  readSessionToken,
  hashToken,
  newToken,
  sessionCookie,
  clearedCookie,
  expiryFrom,
  isExpired,
} from "./session";
import {
  findStaff,
  setPasswordHash,
  createSession,
  findSession,
  deleteSession,
  recordLoginFailure,
  recentFailures,
} from "./store";
import type { Env } from "./pipeline";

/** Failed sign-ins tolerated per account before it is locked out briefly. */
const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

interface Identity {
  name: string;
  isAdmin: boolean;
}

/**
 * Who is making this request, according to the SESSION - never according to
 * anything the client says about itself.
 *
 * Returns null when there is no valid session. The shared admin token grants
 * operational access but deliberately does NOT produce an identity: a token
 * cannot author a message, because then anyone holding it could write history
 * under any staff member's name.
 */
async function identify(request: Request, env: Env): Promise<Identity | null> {
  const token = readSessionToken(request);
  if (token === null) return null;
  const session = await findSession(env.DB, await hashToken(token));
  if (session === null) return null;
  if (isExpired(session.expires_at, new Date())) {
    // Expired sessions are removed on sight rather than left to accumulate.
    await deleteSession(env.DB, await hashToken(token));
    return null;
  }
  return { name: session.staff_name, isAdmin: session.is_admin === 1 };
}

export async function handleApi(url: URL, request: Request, env: Env): Promise<Response> {
  const identity = await identify(request, env);

  if (url.pathname === "/api/login" && request.method === "POST") {
    const raw: unknown = await request.json().catch(() => null);
    const body: Record<string, unknown> =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const name = body["name"];
    const password = body["password"];
    if (typeof name !== "string" || typeof password !== "string") {
      return Response.json({ error: "name and password are required" }, { status: 400 });
    }

    const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000).toISOString();
    if ((await recentFailures(env.DB, name, since)) >= MAX_FAILURES) {
      // Throttled before the password is even checked, so a locked account
      // costs an attacker a request and tells them nothing.
      return Response.json(
        { error: `Too many attempts. Try again in ${String(LOCKOUT_MINUTES)} minutes.` },
        { status: 429 },
      );
    }

    const account = await findStaff(env.DB, name);
    // One message for every failure. Saying "no such user" would confirm which
    // accounts exist, and a different message for "no password set" would say
    // which are worth attacking.
    const rejected = Response.json({ error: "Incorrect name or password" }, { status: 401 });

    if (account === null || account.password_hash === null) {
      await recordLoginFailure(env.DB, name);
      return rejected;
    }
    if (!(await verifyPassword(password, account.password_hash))) {
      await recordLoginFailure(env.DB, name);
      return rejected;
    }

    const token = newToken();
    await createSession(env.DB, await hashToken(token), account.name, expiryFrom(new Date()));
    return new Response(JSON.stringify({ name: account.name, isAdmin: account.is_admin === 1 }), {
      status: 200,
      headers: { "content-type": "application/json", "Set-Cookie": sessionCookie(token) },
    });
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    const token = readSessionToken(request);
    if (token !== null) await deleteSession(env.DB, await hashToken(token));
    return new Response(JSON.stringify({ signedOut: true }), {
      status: 200,
      headers: { "content-type": "application/json", "Set-Cookie": clearedCookie() },
    });
  }

  if (url.pathname === "/api/me") {
    return identity === null
      ? Response.json({ signedIn: false }, { status: 401 })
      : Response.json({ signedIn: true, ...identity });
  }

  // Admin-provisioned passwords (R06): no self-registration, and only an admin
  // may set one. Without a session this is refused outright - the shared token
  // must not be able to hand out credentials.
  if (url.pathname === "/api/staff/password" && request.method === "POST") {
    if (identity === null || !identity.isAdmin) {
      return Response.json({ error: "Admin sign-in required" }, { status: 403 });
    }
    const raw: unknown = await request.json().catch(() => null);
    const body: Record<string, unknown> =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const name = body["name"];
    const password = body["password"];
    if (typeof name !== "string" || typeof password !== "string" || password.length < 12) {
      return Response.json(
        { error: "name and a password of at least 12 characters are required" },
        { status: 400 },
      );
    }
    const changed = await setPasswordHash(env.DB, name, await hashPassword(password));
    return changed
      ? Response.json({ updated: name })
      : Response.json({ error: "No such staff member" }, { status: 404 });
  }

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
