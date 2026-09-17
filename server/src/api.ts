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
  setOwner,
  openTicketsOwnedBy,
  lastAssignee,
  stuckIntents,
  getAttachment,
} from "./store.ts";
import { chooseAssignee } from "./assignment.ts";
import { safeFilename } from "./storage.ts";
import { buildReply } from "./reply.ts";
import { transitionRule, STATUSES, type Status } from "./transitions.ts";
import { responseState } from "./overdue.ts";
import { hashPassword, verifyPassword, SCRYPT_N, SCRYPT_R, SCRYPT_P } from "./password.ts";
import {
  readSessionToken,
  hashToken,
  newToken,
  sessionCookie,
  clearedCookie,
  expiryFrom,
  isExpired,
} from "./session.ts";
import {
  findStaff,
  setPasswordHash,
  createSession,
  findSession,
  deleteSession,
  recordLoginFailure,
  recentFailures,
} from "./store.ts";
import { notifyAssignee, type AppContext } from "./pipeline.ts";

async function workloads(
  env: AppContext,
): Promise<{ name: string; openTickets: number; available: boolean }[]> {
  return (await staffWorkloads(env.pool)).map((member) => ({
    name: member.name,
    openTickets: member.openTickets,
    available: member.available,
  }));
}

/**
 * Move one person's open tickets to whoever can work them (R24).
 *
 * Reassigned one at a time, re-reading workloads each round, so the same
 * fewest-open-tickets rule that spreads new work spreads redistributed work
 * too. Assigning them all in one pass would dump the whole queue on whoever
 * happened to be least loaded at the start.
 */
async function redistribute(
  env: AppContext,
  name: string,
): Promise<{ ticket: number; owner: string | null }[]> {
  const moved: { ticket: number; owner: string | null }[] = [];
  for (const ticket of await openTicketsOwnedBy(env.pool, name)) {
    const candidates = (await workloads(env)).filter((member) => member.name !== name);
    const owner = chooseAssignee(candidates, await lastAssignee(env.pool));
    await setOwner(env.pool, ticket, owner);
    moved.push({ ticket, owner });
  }
  return moved;
}

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
async function identify(request: Request, env: AppContext): Promise<Identity | null> {
  const token = readSessionToken(request);
  if (token === null) return null;
  const session = await findSession(env.pool, await hashToken(token));
  if (session === null) return null;
  if (isExpired(session.expires_at, new Date())) {
    // Expired sessions are removed on sight rather than left to accumulate.
    await deleteSession(env.pool, await hashToken(token));
    return null;
  }
  return { name: session.staff_name, isAdmin: session.is_admin };
}

export async function handleApi(url: URL, request: Request, env: AppContext): Promise<Response> {
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
    if ((await recentFailures(env.pool, name, since)) >= MAX_FAILURES) {
      // Throttled before the password is even checked, so a locked account
      // costs an attacker a request and tells them nothing.
      return Response.json(
        { error: `Too many attempts. Try again in ${String(LOCKOUT_MINUTES)} minutes.` },
        { status: 429 },
      );
    }

    const account = await findStaff(env.pool, name);
    // One message for every failure. Saying "no such user" would confirm which
    // accounts exist, and a different message for "no password set" would say
    // which are worth attacking.
    //
    // ACCEPTED TRADE-OFF (recorded in docs/stack-validation.md): an unknown
    // account returns here WITHOUT running the KDF, so it answers in ~1 ms
    // where a real account takes ~124 ms. That difference is a username
    // enumeration oracle. Hashing a dummy value would even the timing, but it
    // would also let any anonymous caller burn ~124 ms of CPU per request using
    // random names, which the per-account throttle cannot catch. With accounts
    // named staff1-staff5 there is nothing to enumerate, so the DoS vector
    // matters more. Revisit if names ever become non-obvious.
    const rejected = Response.json({ error: "Incorrect name or password" }, { status: 401 });

    if (account === null || account.password_hash === null) {
      await recordLoginFailure(env.pool, name);
      return rejected;
    }
    if (!(await verifyPassword(password, account.password_hash))) {
      await recordLoginFailure(env.pool, name);
      return rejected;
    }

    const token = newToken();
    await createSession(env.pool, await hashToken(token), account.name, expiryFrom(new Date()));
    return new Response(JSON.stringify({ name: account.name, isAdmin: account.is_admin }), {
      status: 200,
      headers: { "content-type": "application/json", "Set-Cookie": sessionCookie(token) },
    });
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    const token = readSessionToken(request);
    if (token !== null) await deleteSession(env.pool, await hashToken(token));
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
    const changed = await setPasswordHash(env.pool, name, await hashPassword(password));
    return changed
      ? Response.json({ updated: name })
      : Response.json({ error: "No such staff member" }, { status: 404 });
  }

  // ---- dashboard API ----------------------------------------------------
  // Everything below this line requires a real session (R06). The shared admin
  // token opens the operational routes and deliberately does not reach here:
  // it carries no identity, so it could only ever write history under a name
  // it made up. `author` therefore comes from the session, never from the
  // request body - which is what makes the ticket history an audit trail
  // rather than a record of what the client claimed.
  if (identity === null) {
    return Response.json({ error: "Sign-in required" }, { status: 401 });
  }

  if (url.pathname === "/api/staff") {
    if (request.method === "GET") {
      return Response.json({ staff: await staffWorkloads(env.pool) });
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
        if (!identity.isAdmin) {
          return Response.json({ error: "Admin sign-in required" }, { status: 403 });
        }
        const available = payload["available"] === true;
        const changed = await setAvailability(env.pool, name, available);
        if (!changed) {
          return Response.json({ error: "No such staff member" }, { status: 404 });
        }
        // R24: their open tickets move to whoever can work them. Marking
        // somebody unavailable and leaving their queue where it is produces
        // tickets that look owned and that nobody is looking at - the exact
        // failure the requirement exists to prevent.
        const redistributed = available ? [] : await redistribute(env, name);
        for (const move of redistributed) {
          if (move.owner !== null) await notifyAssignee(env, move.ticket, "assigned");
        }
        return Response.json({ updated: name, available, redistributed });
      }

      await addStaff(env.pool, name, email);
      return Response.json({ added: name });
    }
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (url.pathname === "/api/tickets" && request.method === "GET") {
    const now = new Date();
    const tickets = (await listTickets(env.pool)).map((ticket) => ({
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

  const ticketMatch = /^\/api\/tickets\/(\d+)(\/reply|\/note|\/status|\/assign)?$/.exec(
    url.pathname,
  );
  if (ticketMatch !== null) {
    const id = Number(ticketMatch[1]);
    const detail = await getTicket(env.pool, id);
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
      if (ticketMatch[2] !== "/assign" && (typeof body !== "string" || body.trim().length === 0)) {
        return Response.json({ error: "A body is required" }, { status: 400 });
      }
      const text = typeof body === "string" ? body : "";
      // NOT payload["author"]. Whoever is signed in is the author; a client
      // that says otherwise is ignored.
      const author = identity.name;

      if (ticketMatch[2] === "/assign") {
        // Only an admin may hand work to someone else; anyone signed in may
        // take an unowned ticket themselves.
        const requested = payload["owner"];
        const owner =
          payload["auto"] === true
            ? chooseAssignee(await workloads(env), await lastAssignee(env.pool))
            : requested === null
              ? null
              : typeof requested === "string"
                ? requested
                : identity.name;
        if (owner !== identity.name && !identity.isAdmin) {
          return Response.json({ error: "Admin sign-in required" }, { status: 403 });
        }
        await setOwner(env.pool, id, owner);
        // R08/R15: "record each assignment change and notify new owners."
        if (owner !== null && owner !== detail.ticket.owner) {
          await notifyAssignee(env, id, "assigned");
        }
        return Response.json({ ticket: id, owner });
      }

      // An internal note never touches the outbox. See store.addNote.
      if (ticketMatch[2] === "/note") {
        await addNote(env.pool, id, author, text);
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
          await setStatus(env.pool, id, target);
          return Response.json({ status: target, applied: "immediately" });
        }

        // R28: queue the message that justifies the change and hang the
        // transition off it. The status does not move until the server
        // accepts - recordAcceptance applies both in one batch.
        const message = buildReply({
          ticketNumber: id,
          ticketSubject: detail.ticket.subject,
          requester: detail.ticket.requester,
          supportAddress: `SimpleTickets <${env.config.supportAddress}>`,
          body: text,
          threadMessageIds: await threadIds(env.pool, id),
          date: new Date(),
        });
        await addReply(env.pool, {
          ticketId: id,
          author,
          body: text,
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
          supportAddress: `SimpleTickets <${env.config.supportAddress}>`,
          body: text,
          threadMessageIds: await threadIds(env.pool, id),
          date: new Date(),
        });
        await addReply(env.pool, {
          ticketId: id,
          author,
          body: text,
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

  // Outgoing mail that needs a human (R15, T013): permanently failed, of
  // unknown outcome, or bounced after acceptance. Surfaced as its own route
  // because a queue that silently stops delivering looks identical to an empty
  // one from the ticket list.
  if (url.pathname === "/api/outbox" && request.method === "GET") {
    return Response.json({ stuck: await stuckIntents(env.pool) });
  }

  // Attachments (R12). Served through the API rather than from a static
  // directory so that the session check applies: these are employees' files.
  const attachmentMatch = /^\/api\/attachments\/(\d+)$/.exec(url.pathname);
  if (attachmentMatch !== null && request.method === "GET") {
    const record = await getAttachment(env.pool, Number(attachmentMatch[1]));
    if (record === null) return Response.json({ error: "No such attachment" }, { status: 404 });
    let content: Buffer;
    try {
      content = await env.storage.read(record.path);
    } catch {
      // The row survives, the file does not. Saying so beats a 500 that looks
      // like the server is broken.
      return Response.json({ error: "Attachment file is missing" }, { status: 410 });
    }
    // safeFilename again here, not only at ingest. The stored name is only as
    // trustworthy as whatever wrote the row, and a path like "../../etc/passwd"
    // reaching Content-Disposition is what some download managers happily obey.
    // Same reasoning as the path check inside Storage.absolute.
    const filename = safeFilename(record.filename).replace(/["\\]/g, "");
    return new Response(new Uint8Array(content), {
      headers: {
        // Never the stored content-type verbatim: an employee's "image/png"
        // that is really HTML would run as script on the dashboard's own
        // origin. The browser is told to save it, not to interpret it.
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(content.length),
      },
    });
  }

  // Proves the password KDF works on this runtime with these parameters and
  // reports what it costs. Hashes a throwaway random string; no real password
  // is involved. Unlike the Workers version, the timings here are real -
  // Cloudflare froze Date.now() during synchronous execution, which made every
  // in-request measurement read zero.
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
      parameters: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      memoryBytes: 128 * SCRYPT_N * SCRYPT_R,
      hashedMs,
      verifyMs,
      correctAccepted: accepted,
      wrongRejected: !rejected,
      ok: accepted && !rejected,
    });
  }

  return Response.json({ error: "No such endpoint" }, { status: 404 });
}
