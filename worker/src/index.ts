/**
 * SimpleTickets worker entry point.
 *
 * The pipeline itself lives in ./pipeline so the Durable Object in ./ticker can
 * use it too, without importing this module and creating a cycle.
 *
 * `scheduled()` is retained even though Cloudflare's cron triggers do not fire
 * on this account: if they ever start working it costs nothing, and the tick is
 * idempotent either way. The Durable Object alarm in ./ticker is what actually
 * drives the system.
 */
import { ingest, flushOutbox, type Env } from "./pipeline";
import { peekRecent } from "./imap";
import {
  readCheckpoint,
  outboxSummary,
  listTickets,
  getTicket,
  threadIds,
  addReply,
  addNote,
} from "./store";
import { buildReply } from "./reply";
import { isAuthorised } from "./auth";

export { Ticker } from "./ticker";
export type { Env };

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

    // The ticker is a single named instance: one driver, not one per request.
    // Reaching it through the worker keeps it behind the same token as
    // everything else - a Durable Object has no auth of its own.
    if (url.pathname.startsWith("/ticker")) {
      const id = env.TICKER.idFromName("ingest-ticker");
      const action = url.pathname.slice("/ticker".length) || "/status";
      return env.TICKER.get(id).fetch(new Request(`https://ticker${action}`, request));
    }

    // ---- dashboard API ----------------------------------------------------
    // Everything here is behind the same single admin token as the operational
    // routes. That is NOT multi-user authentication: there is one shared
    // secret, so the API cannot tell one staff member from another and nothing
    // here may be treated as an audit trail of who did what. Real per-staff
    // sign-in is R06, still blocked on the Workers PBKDF2 cap.

    if (url.pathname === "/api/tickets" && request.method === "GET") {
      return Response.json({ tickets: await listTickets(env.DB) });
    }

    const ticketMatch = /^\/api\/tickets\/(\d+)(\/reply|\/note)?$/.exec(url.pathname);
    if (ticketMatch !== null) {
      const id = Number(ticketMatch[1]);
      const detail = await getTicket(env.DB, id);
      if (detail === null) {
        return Response.json({ error: "No such ticket" }, { status: 404 });
      }

      if (request.method === "GET" && ticketMatch[2] === undefined) {
        return Response.json(detail);
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

    // Read-only. Deliberately separate from /poll, which now sends mail:
    // inspecting the mailbox must never be able to email anyone.
    if (url.pathname === "/peek") {
      return Response.json(await peekRecent(env.GMAIL_USER, env.GMAIL_APP_PASSWORD));
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
