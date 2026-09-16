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
import { readCheckpoint, outboxSummary } from "./store";
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
