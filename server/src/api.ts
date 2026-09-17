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
  setEnabled,
  setStatus,
  setPriority,
  PRIORITIES,
  type Priority,
  setOwner,
  openTicketsOwnedBy,
  stuckIntents,
  requeueIntent,
  getAttachment,
  recordAudit,
  recentAudit,
  listParticipants,
  participantHistory,
  addParticipants,
  removeParticipant,
  listTemplates,
  getTemplate,
  upsertTemplate,
  deleteTemplate,
  findStaff,
  setPasswordHash,
  createSession,
  findSession,
  deleteSession,
  recordLoginFailure,
  recentFailures,
  storeLoginCode,
  consumeLoginCode,
  sweepExpiredCodes,
} from "./store.ts";
import { buildLoginCode } from "./login-code.ts";
import { sendMessage } from "./smtp.ts";
import { eligibleParticipants } from "./domain.ts";
import { safeFilename } from "./storage.ts";
import { buildReply } from "./reply.ts";
import { transitionRule, STATUSES, type Status } from "./transitions.ts";
import { responseState } from "./overdue.ts";
import { hashPassword, verifyPassword, SCRYPT_N, SCRYPT_R, SCRYPT_P } from "./password.ts";
import {
  readSessionToken,
  hashToken,
  newToken,
  newCode,
  codeExpiryFrom,
  sessionCookie,
  clearedCookie,
  expiryFrom,
  isExpired,
} from "./session.ts";
import { notifyAssignee, assignUnassigned, assignTicket, type AppContext } from "./pipeline.ts";

/** Read and validate a JSON request body without casting it. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw: unknown = await request.json().catch(() => null);
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
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
  actor: string,
): Promise<{ ticket: number; owner: string | null }[]> {
  const moved: { ticket: number; owner: string | null }[] = [];
  for (const ticket of await openTicketsOwnedBy(env.pool, name)) {
    // Excluding the person being moved away from: without it they can win
    // their own tickets back, since they are still `available` until the flag
    // commits and are by then the least loaded.
    moved.push({ ticket, owner: await assignTicket(env, ticket, actor, name) });
  }
  return moved;
}

/**
 * Statuses a reply template may request (R24).
 *
 * Closure is absent on purpose: R24 says closure is not a template action, and
 * New is absent because a ticket never goes back to it.
 */
const TEMPLATE_STATUSES = ["In Progress", "Waiting for Employee", "Resolved"];

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
  // Disabling deletes the session rows, so reaching here with a disabled
  // account means a request that was already in flight when the DELETE ran.
  // Rare, and the cost of covering it is one column on a join we already do.
  if (!session.enabled) return null;
  return { name: session.staff_name, isAdmin: session.is_admin };
}

export async function handleApi(url: URL, request: Request, env: AppContext): Promise<Response> {
  const identity = await identify(request, env);

  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await readJson(request);
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

    // A disabled account is refused with the same message as a wrong password.
    // Saying "this account is disabled" would confirm the name exists and that
    // it used to work, which is exactly what someone probing a leaver's
    // credentials wants to know.
    if (account === null || account.password_hash === null || !account.enabled) {
      await recordLoginFailure(env.pool, name);
      return rejected;
    }
    if (!(await verifyPassword(password, account.password_hash))) {
      await recordLoginFailure(env.pool, name);
      return rejected;
    }

    // R06: the second factor. With it off, the password alone signs you in -
    // which is what every test and every local run does, and why the setting
    // exists rather than the behaviour being unconditional.
    if (env.config.loginCodes) {
      // No address, no code, and therefore no way in. Answered like any other
      // failure rather than "this account has no email", which would say which
      // accounts are misconfigured to anyone who asks.
      const to = account.email;
      if (to === null || to === "") {
        await recordLoginFailure(env.pool, name);
        return rejected;
      }
      const code = newCode();
      await sweepExpiredCodes(env.pool, new Date());
      await storeLoginCode(
        env.pool,
        account.name,
        await hashToken(code),
        codeExpiryFrom(new Date()),
      );
      // Sent inline rather than queued. Everything else in this system is
      // queued because nobody is waiting for it; somebody IS waiting for this,
      // and a code that arrives on the next two-minute poll is a code nobody
      // will use. A failure here is reported rather than swallowed: silently
      // "sending" a code that never left is how a person sits refreshing an
      // inbox.
      try {
        await sendMessage({
          user: env.config.gmailUser,
          appPassword: env.config.gmailAppPassword,
          message: buildLoginCode({
            code,
            recipient: to,
            supportAddress: `SimpleTickets <${env.config.fromAddress}>`,
            date: new Date(),
          }),
          envelopeFrom: env.config.gmailUser,
          envelopeTo: [to],
        });
      } catch (error) {
        console.error(JSON.stringify({ event: "login_code_failed", error: String(error) }));
        return Response.json(
          { error: "Could not send your sign-in code. Tell your administrator." },
          { status: 502 },
        );
      }
      // No session yet, and no cookie. The password has been accepted and
      // nothing more.
      return Response.json({ codeRequired: true, name: account.name });
    }

    const token = newToken();
    await createSession(env.pool, await hashToken(token), account.name, expiryFrom(new Date()));
    return new Response(JSON.stringify({ name: account.name, isAdmin: account.is_admin }), {
      status: 200,
      headers: { "content-type": "application/json", "Set-Cookie": sessionCookie(token) },
    });
  }

  /**
   * The second step of sign-in (R06).
   *
   * Throttled by the same per-account counter as the password, so an attacker
   * who has the password cannot grind codes freely - five wrong codes on the
   * row, and the account's failure count, both push back.
   *
   * Every failure returns the same message. Distinguishing "expired" from
   * "wrong" from "no code was issued" would confirm which accounts have had a
   * code sent, which is to say which passwords are already known.
   */
  if (url.pathname === "/api/login/verify" && request.method === "POST") {
    const body = await readJson(request);
    const name = body["name"];
    const code = body["code"];
    if (typeof name !== "string" || typeof code !== "string") {
      return Response.json({ error: "name and code are required" }, { status: 400 });
    }

    const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000).toISOString();
    if ((await recentFailures(env.pool, name, since)) >= MAX_FAILURES) {
      return Response.json(
        { error: `Too many attempts. Try again in ${String(LOCKOUT_MINUTES)} minutes.` },
        { status: 429 },
      );
    }

    const outcome = await consumeLoginCode(env.pool, name, await hashToken(code), new Date());
    if (outcome !== "accepted") {
      await recordLoginFailure(env.pool, name);
      return Response.json({ error: "That code is not right" }, { status: 401 });
    }

    // Re-read the account rather than trusting the earlier step: it may have
    // been disabled in the ten minutes since the password was accepted.
    const account = await findStaff(env.pool, name);
    if (account === null || !account.enabled) {
      return Response.json({ error: "That code is not right" }, { status: 401 });
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
    const body = await readJson(request);
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
      const payload = await readJson(request);
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
        const changed = await setAvailability(env.pool, name, available, identity.name);
        if (!changed) {
          return Response.json({ error: "No such staff member" }, { status: 404 });
        }
        // R24: their open tickets move to whoever can work them. Marking
        // somebody unavailable and leaving their queue where it is produces
        // tickets that look owned and that nobody is looking at - the exact
        // failure the requirement exists to prevent.
        const redistributed = available ? [] : await redistribute(env, name, identity.name);
        for (const move of redistributed) {
          if (move.owner !== null) await notifyAssignee(env, move.ticket, "assigned");
        }
        // Coming back available picks up what nobody owns - and ONLY that. R24
        // is explicit that restoring availability must not rebalance tickets
        // already being worked by somebody else.
        const picked = available ? await assignUnassigned(env, identity.name) : 0;
        return Response.json({ updated: name, available, redistributed, assigned: picked });
      }

      // Account access (R24). Disabling revokes sign-in, kills live sessions
      // and redistributes work, all of which availability deliberately does
      // not do - somebody on leave keeps their login, a leaver does not.
      if ("enabled" in payload) {
        if (!identity.isAdmin) {
          return Response.json({ error: "Admin sign-in required" }, { status: 403 });
        }
        if (name === identity.name && payload["enabled"] !== true) {
          // An admin disabling their own account locks the last door from the
          // inside: only an admin may re-enable one, and only from a session
          // this would have just deleted.
          return Response.json({ error: "You cannot disable your own account" }, { status: 409 });
        }
        const enabled = payload["enabled"] === true;
        const result = await setEnabled(env.pool, name, enabled, identity.name);
        if (result === null) {
          return Response.json({ error: "No such staff member" }, { status: 404 });
        }
        const redistributed = enabled ? [] : await redistribute(env, name, identity.name);
        for (const move of redistributed) {
          if (move.owner !== null) await notifyAssignee(env, move.ticket, "assigned");
        }
        // Re-enabling returns nothing: the tickets moved on when the account
        // was disabled, and whoever picked them up has been answering the
        // employee since.
        return Response.json({
          updated: name,
          enabled,
          sessionsRevoked: result.sessionsRevoked,
          redistributed,
        });
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

  const ticketMatch =
    /^\/api\/tickets\/(\d+)(\/reply|\/note|\/status|\/assign|\/participants|\/priority)?$/.exec(
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
      const payload = await readJson(request);
      const body = payload["body"];
      // Only the routes that actually SEND something need a message. Assigning
      // and editing the participant list do not, and demanding one made both
      // answer 400 to a perfectly well-formed request.
      const needsMessage =
        ticketMatch[2] !== "/assign" &&
        ticketMatch[2] !== "/participants" &&
        ticketMatch[2] !== "/priority";
      if (needsMessage && (typeof body !== "string" || body.trim().length === 0)) {
        return Response.json({ error: "A body is required" }, { status: 400 });
      }
      const text = typeof body === "string" ? body : "";
      // NOT payload["author"]. Whoever is signed in is the author; a client
      // that says otherwise is ignored.
      const author = identity.name;

      // R11/R22: priority is a signal to whoever works the queue - it changes
      // no deadline - which is exactly why who changed it is worth recording.
      if (ticketMatch[2] === "/priority") {
        const requested = payload["priority"];
        if (typeof requested !== "string" || !PRIORITIES.includes(requested as Priority)) {
          return Response.json(
            { error: `priority must be one of: ${PRIORITIES.join(", ")}` },
            { status: 400 },
          );
        }
        const changed = await setPriority(env.pool, id, requested as Priority, identity.name);
        return Response.json({ ticket: id, priority: requested, changed });
      }

      // R25: IT manages who is copied on a ticket. Additions and removals are
      // both explicit acts and both audited - an address dropping out of a Cc
      // header never removes anybody, which is what the requirement says in as
      // many words.
      if (ticketMatch[2] === "/participants") {
        const remove = payload["remove"];
        if (typeof remove === "string") {
          const removed = await removeParticipant(env.pool, id, remove, identity.name);
          return removed
            ? Response.json({ removed: remove.toLowerCase() })
            : Response.json({ error: "Not a participant on this ticket" }, { status: 404 });
        }
        const requested = payload["add"];
        const list = Array.isArray(requested)
          ? requested.filter((entry): entry is string => typeof entry === "string")
          : typeof requested === "string"
            ? [requested]
            : [];
        // Same domain rule as an emailed CC, and for the same reason: an
        // external address added from the dashboard would receive an
        // employee's IT correspondence exactly as one added by email would.
        const eligible = eligibleParticipants(list.join(", "), [
          detail.ticket.requester,
          env.config.supportAddress,
          env.config.gmailUser,
        ]);
        const refused = list.filter(
          (entry) => !eligible.some((address) => entry.toLowerCase().includes(address)),
        );
        const added = await addParticipants(env.pool, id, eligible, identity.name);
        return Response.json({
          added,
          refused,
          participants: await participantHistory(env.pool, id),
        });
      }

      if (ticketMatch[2] === "/assign") {
        // Only an admin may hand work to someone else; anyone signed in may
        // take an unowned ticket themselves.
        // "auto" hands the choice back to the R07 rule, under the assignment
        // lock, rather than naming somebody.
        if (payload["auto"] === true) {
          if (!identity.isAdmin) {
            return Response.json({ error: "Admin sign-in required" }, { status: 403 });
          }
          const chosen = await assignTicket(env, id, identity.name);
          if (chosen !== null) await notifyAssignee(env, id, "assigned");
          return Response.json({ ticket: id, owner: chosen, changed: chosen !== null });
        }

        const requested = payload["owner"];
        const owner =
          requested === null ? null : typeof requested === "string" ? requested : identity.name;
        if (owner !== identity.name && !identity.isAdmin) {
          return Response.json({ error: "Admin sign-in required" }, { status: 403 });
        }
        // R08/R15: "record each assignment change and notify new owners."
        // setOwner writes the audit entry; it returns false when the ticket
        // already had that owner, which is not a change to announce.
        const moved = await setOwner(env.pool, id, owner, identity.name);
        if (moved && owner !== null) {
          await notifyAssignee(env, id, "assigned");
        }
        return Response.json({ ticket: id, owner, changed: moved });
      }

      // An internal note never touches the outbox. See store.addNote.
      if (ticketMatch[2] === "/note") {
        await addNote(env.pool, id, author, text);
        return Response.json({ added: "note" });
      }

      // Everyone this ticket's public mail goes to (R25). Read once here so
      // /reply and /status compose identically - a reply that copied the
      // colleagues and a resolution that did not would tell half the audience
      // the problem was fixed.
      const participants = await listParticipants(env.pool, id);

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
          await setStatus(env.pool, id, target, identity.name);
          return Response.json({ status: target, applied: "immediately" });
        }

        // R28: queue the message that justifies the change and hang the
        // transition off it. The status does not move until the server
        // accepts - recordAcceptance applies both in one batch.
        const message = buildReply({
          ticketNumber: id,
          ticketSubject: detail.ticket.subject,
          requester: detail.ticket.requester,
          participants,
          supportAddress: `SimpleTickets <${env.config.fromAddress}>`,
          body: text,
          // R14, from the session. A client that named somebody else would be
          // signing a colleague's name to its own message.
          signedBy: author,
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
        await recordAudit(env.pool, {
          ticketId: id,
          actor: author,
          action: "status_requested",
          detail: `${target} (waiting on ${rule.intent} delivery)`,
        });
        return Response.json({
          queued: true,
          intent: rule.intent,
          pendingStatus: target,
          note: "Status changes when the mail server accepts this message (R28).",
        });
      }

      if (ticketMatch[2] === "/reply") {
        // R24: a template may carry a status. The BODY still comes from the
        // request, never from the template row - staff may edit a selected
        // reply before sending, and that edit must reach the employee while
        // leaving the shared template alone. Only the mapping is read here.
        const requestedTemplate = payload["templateId"];
        const template =
          typeof requestedTemplate === "number"
            ? await getTemplate(env.pool, requestedTemplate)
            : null;
        if (typeof requestedTemplate === "number" && template === null) {
          return Response.json({ error: "No such template" }, { status: 404 });
        }

        const mapped = template?.maps_to ?? null;
        const rule =
          mapped === null ? null : transitionRule(detail.ticket.status as Status, mapped as Status);
        // A template whose mapping does not apply to this ticket - "Issue
        // resolved" on an already-Resolved one - sends the reply and leaves the
        // status alone. Refusing the whole send would lose what IT wrote over a
        // status they may not have been thinking about.
        const gated = rule?.kind === "delivery-gated" ? rule : null;

        const message = buildReply({
          ticketNumber: id,
          ticketSubject: detail.ticket.subject,
          requester: detail.ticket.requester,
          participants,
          supportAddress: `SimpleTickets <${env.config.fromAddress}>`,
          body: text,
          // R14, from the session. A client that named somebody else would be
          // signing a colleague's name to its own message.
          signedBy: author,
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
          ...(gated === null || mapped === null
            ? {}
            : { intent: gated.intent, pendingStatus: mapped }),
        });

        // An immediate mapping (In Progress) applies now; a gated one rides on
        // the outbox row and applies when the server accepts it (R28).
        if (rule?.kind === "immediate" && mapped !== null) {
          await setStatus(env.pool, id, mapped, author);
        } else if (gated !== null && mapped !== null) {
          await recordAudit(env.pool, {
            ticketId: id,
            actor: author,
            action: "status_requested",
            detail: `${mapped} (waiting on ${gated.intent} delivery)`,
          });
        }

        // Queued, not sent. The ticker delivers it on its next tick, so a
        // slow or refusing SMTP server cannot block the dashboard.
        return Response.json({
          queued: true,
          messageId: message.messageId,
          copiedTo: participants,
          ...(mapped === null
            ? {}
            : rule?.kind === "immediate"
              ? { status: mapped, applied: "immediately" }
              : gated === null
                ? { statusUnchanged: rule?.kind === "invalid" ? rule.reason : null }
                : { pendingStatus: mapped }),
        });
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

  /**
   * Put a bounced, failed or ambiguous message back in the queue (R28).
   *
   * This is what re-anchors an auto-close clock: `requeueIntent` clears
   * accepted_at, so a resolution that bounced and is resent counts its 72 hours
   * from the new acceptance rather than from the delivery that never arrived.
   *
   * Ambiguous rows are included deliberately, and this is the human decision
   * PRD open point 4 parks: only a person can say whether a send whose outcome
   * was never learned should be tried again.
   */
  const resendMatch = /^\/api\/outbox\/(\d+)\/resend$/.exec(url.pathname);
  if (resendMatch !== null && request.method === "POST") {
    const outboxId = Number(resendMatch[1]);
    const requeued = await requeueIntent(env.pool, outboxId);
    if (!requeued) {
      return Response.json(
        { error: "Nothing to resend: no such message, or it is not failed, bounced or ambiguous" },
        { status: 409 },
      );
    }
    await recordAudit(env.pool, {
      actor: identity.name,
      action: "resend_queued",
      detail: `outbox ${String(outboxId)}`,
    });
    return Response.json({ requeued: outboxId });
  }

  /** The audit trail (R08). Everything, newest first; per-ticket lives on the detail. */
  if (url.pathname === "/api/audit" && request.method === "GET") {
    return Response.json({ audit: await recentAudit(env.pool) });
  }

  /**
   * Reply templates (R24).
   *
   * Reading is open to all five staff; writing is admin-only, because these are
   * shared wording that goes out under everyone's name. Editing one never
   * touches what has already been sent: the outgoing text is copied into
   * `messages` and into the outbox payload at send time.
   */
  const templateMatch = /^\/api\/templates(?:\/(\d+))?$/.exec(url.pathname);
  if (templateMatch !== null) {
    if (request.method === "GET") {
      return Response.json({ templates: await listTemplates(env.pool) });
    }
    if (!identity.isAdmin) {
      return Response.json({ error: "Admin sign-in required" }, { status: 403 });
    }
    const existing = templateMatch[1] === undefined ? undefined : Number(templateMatch[1]);

    if (request.method === "DELETE" && existing !== undefined) {
      const removed = await deleteTemplate(env.pool, existing);
      if (removed) {
        await recordAudit(env.pool, {
          actor: identity.name,
          action: "template_deleted",
          detail: String(existing),
        });
      }
      return removed
        ? Response.json({ deleted: existing })
        : Response.json({ error: "No such template" }, { status: 404 });
    }

    if (request.method === "POST" || request.method === "PUT") {
      const payload = await readJson(request);
      const name = payload["name"];
      const body = payload["body"];
      if (
        typeof name !== "string" ||
        name.trim().length === 0 ||
        typeof body !== "string" ||
        body.trim().length === 0
      ) {
        return Response.json({ error: "A name and a body are required" }, { status: 400 });
      }
      // R24: closure is deliberately not a template action, and no other status
      // may be mapped. The database CHECK says the same thing; this says it
      // before the row is attempted, with a message that explains itself.
      const requested = payload["mapsTo"];
      const mapsTo = typeof requested === "string" && requested !== "" ? requested : null;
      if (mapsTo !== null && !TEMPLATE_STATUSES.includes(mapsTo)) {
        return Response.json(
          { error: `mapsTo must be null or one of: ${TEMPLATE_STATUSES.join(", ")}` },
          { status: 400 },
        );
      }
      const saved = await upsertTemplate(env.pool, {
        ...(existing === undefined ? {} : { id: existing }),
        name: name.trim(),
        body,
        mapsTo,
      });
      if (saved === null) {
        return Response.json({ error: "No such template" }, { status: 404 });
      }
      await recordAudit(env.pool, {
        actor: identity.name,
        action: existing === undefined ? "template_created" : "template_updated",
        detail: saved.name,
      });
      return Response.json({ template: saved });
    }
    return Response.json({ error: "Method not allowed" }, { status: 405 });
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
