/**
 * SimpleTickets server: HTTP API and the mail loop, in one process.
 *
 * One process on purpose. The Cloudflare build needed three moving parts — a
 * worker for HTTP, a Durable Object for the timer, and a cron trigger that
 * never fired — because the platform had no way to simply keep something
 * running. Here `setInterval` does it, and the ticker shares the connection
 * pool with the API instead of reaching it through a binding.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { Storage } from "./storage.ts";
import { Ticker, TICK_INTERVAL_MS } from "./ticker.ts";
import { ingest, flushOutbox, sendReminders, autoClose, type AppContext } from "./pipeline.ts";
import { handleApi } from "./api.ts";
import { readCheckpoint, outboxSummary, recordAudit } from "./store.ts";
import { peekRecent, listFolders } from "./imap.ts";
import { isAuthorised } from "./auth.ts";
import { startBackups, backupNow, backupState, storageUsage } from "./backup.ts";

const pool = createPool(config.databaseUrl);
const storage = new Storage(config.storageDir);
const env: AppContext = { pool, storage, config };

/** One tick: read the mailbox, queue reminders and closures, then send. */
async function tick(): Promise<{
  ingest: unknown;
  reminders: number;
  closed: number;
  outbox: unknown;
}> {
  const summary = await ingest(env);
  // Before the flush, so a reminder queued now goes out on this tick rather
  // than waiting two minutes for the next one.
  const reminders = await sendReminders(env);
  const closed = await autoClose(env);
  const outbox = await flushOutbox(env);
  // Counts only: subjects and addresses stay out of the logs.
  console.log(JSON.stringify({ event: "tick", ...summary, reminders, closed, outbox }));
  return { ingest: summary, reminders, closed, outbox };
}

const ticker = new Ticker(tick, TICK_INTERVAL_MS);

/**
 * Record a failed backup where a person will see it (R23).
 *
 * Deliberately NOT an email. The alert channel for "the database could not be
 * backed up" should not be the mail queue that lives in that database, and an
 * outbox row needs a ticket to hang off - there is no ticket here. It goes to
 * the audit trail, to /health and to /status instead, which is where a watchdog
 * and an admin actually look.
 */
async function recordBackupFailure(error: string): Promise<void> {
  await recordAudit(pool, {
    actor: "system",
    action: "backup_failed",
    detail: error.slice(0, 500),
  });
}

/** Mail runs only when there are credentials for it. */
function mailConfigured(): boolean {
  return config.gmailUser !== "" && config.gmailAppPassword !== "";
}
const app = new Hono();

/**
 * Liveness. Deliberately unauthenticated and deliberately free of ticket data:
 * something has to be able to ask "is this up and is the mail loop beating?"
 * without holding a credential.
 */
app.get("/health", (c) => {
  const status = ticker.status();
  // Stalled only counts against health when the loop is supposed to be
  // beating. A server started without mail credentials is not broken, and a
  // watchdog that cannot tell "switched off" from "died" is one that gets
  // ignored - which is how a real stall goes unnoticed.
  const stalled = status.running && status.health.stalled;
  // R23: a backup that has started failing is reported here rather than only
  // logged. This endpoint is what monitoring polls; nobody reads yesterday's
  // logs to find out whether last night's backup worked.
  const backup = backupState();
  const degraded = stalled || backup.failing;
  return c.json(
    {
      ok: !degraded,
      mail: mailConfigured() ? "enabled" : "disabled",
      ticker: status,
      backup,
    },
    degraded ? 503 : 200,
  );
});

/**
 * The dashboard API. Session-authenticated inside handleApi — no token here,
 * because the browser holds a session cookie and never a shared secret.
 */
app.all("/api/*", async (c) => handleApi(new URL(c.req.url), c.req.raw, env));

/**
 * Operational routes, behind the shared admin token. For running the system,
 * not for staff: see auth.ts.
 *
 * The guard is registered against each path by name rather than as a wildcard
 * on a sub-router mounted at "/". That wildcard matched every request,
 * including the dashboard itself, and answered 404 to the browser before the
 * SPA fallback below was ever reached.
 */
const OPS_PATHS = [
  "/status",
  "/ticker",
  "/ticker/*",
  "/peek",
  "/diag",
  "/poll",
  "/flush",
  "/backup",
];
const ops = new Hono();
for (const path of OPS_PATHS) {
  ops.use(path, async (c, next) => {
    if (!isAuthorised(config.adminToken, c.req.header("x-admin-token") ?? null)) {
      // 404 rather than 401: the routes do not announce that they exist.
      return c.text("Not found", 404);
    }
    await next();
    return undefined;
  });
}

ops.get("/status", async (c) =>
  c.json({
    checkpoint: await readCheckpoint(pool),
    counts: (
      await pool.query<{
        tickets: number;
        messages: number;
        examined: number;
        attachments: number;
      }>(
        `SELECT (SELECT COUNT(*)::int FROM tickets)     AS tickets,
                (SELECT COUNT(*)::int FROM messages)    AS messages,
                (SELECT COUNT(*)::int FROM ingest_log)  AS examined,
                (SELECT COUNT(*)::int FROM attachments) AS attachments`,
      )
    ).rows[0],
    outbox: await outboxSummary(pool),
    ticker: ticker.status(),
    mailSend: config.mailSend,
    backup: backupState(),
    // R23: storage monitoring. Attachments and archived raw messages grow
    // without limit, and the first sign of a full disk should not be a backup
    // that failed last night.
    storage: {
      attachments: await storageUsage(config.storageDir),
      backups: await storageUsage(config.backupDir),
    },
  }),
);

ops.get("/ticker", (c) => c.json(ticker.status()));
ops.post("/ticker/start", (c) => {
  ticker.start();
  return c.json(ticker.status());
});
ops.post("/ticker/stop", (c) => {
  ticker.stop();
  return c.json(ticker.status());
});

/** Read-only. Separate from /poll, which sends: inspecting must never email. */
ops.get("/peek", async (c) => c.json(await peekRecent(config.gmailUser, config.gmailAppPassword)));
ops.get("/diag", async (c) => c.json(await listFolders(config.gmailUser, config.gmailAppPassword)));
ops.post("/poll", async (c) => c.json(await tick()));
ops.post("/flush", async (c) => c.json(await flushOutbox(env)));
/** Take a recovery point now, off-schedule: before an upgrade, or after a fix. */
ops.post("/backup", async (c) => c.json(await backupNow(config, recordBackupFailure)));

app.route("/", ops);

/**
 * The dashboard itself, served from this origin.
 *
 * Same origin is the point: the browser sends its session cookie with no CORS
 * involved, and the bundle carries no API token — which was the flaw that made
 * the Cloudflare dashboard unsafe to hand to staff. The SPA fallback below
 * returns index.html for unknown paths so a deep link survives a refresh.
 */
const DASHBOARD = join(import.meta.dirname, "../../prototype/dist");
app.use("/assets/*", serveStatic({ root: "../prototype/dist" }));
app.get("*", async (c) => {
  try {
    return c.html(await readFile(join(DASHBOARD, "index.html"), "utf8"));
  } catch {
    return c.text(
      "Dashboard not built. Run `npm run build` in prototype/, or use `npm run dev` there for the live one.",
      503,
    );
  }
});

async function main(): Promise<void> {
  const applied = await migrate(config.databaseUrl);
  if (applied.length > 0) console.log(JSON.stringify({ event: "migrated", applied }));

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(
      JSON.stringify({
        event: "listening",
        url: `http://localhost:${String(info.port)}`,
        mailSend: config.mailSend,
        database: config.databaseUrl.replace(/:[^:@/]*@/, ":***@"),
      }),
    );
  });

  // Mail only runs when there are credentials for it. Without them the API and
  // dashboard still work against whatever is already in the database, which is
  // what makes UI work possible without the mailbox password.
  if (!mailConfigured()) {
    console.warn(
      JSON.stringify({
        event: "mail_disabled",
        reason: "GMAIL_USER or GMAIL_APP_PASSWORD is unset; ingestion will not start.",
      }),
    );
  } else {
    ticker.start();
    void ticker.tick();
  }

  startBackups(config, recordBackupFailure);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      ticker.stop();
      void pool.end().finally(() => process.exit(0));
    });
  }
}

await main();
