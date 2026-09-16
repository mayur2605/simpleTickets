/**
 * Throwaway probe: does the Gmail App Password authenticate from a Worker, and
 * can we read the mailbox?
 *
 * Reports structure only - mailbox counts and UID markers. No subjects, no
 * addresses, no message content, because this is a diagnostic and the
 * constitution keeps mail content out of logs and responses.
 *
 * Delete once the answer is recorded.
 */
import { ImapFlow } from "imapflow";

interface Env {
  GMAIL_USER: string;
  GMAIL_APP_PASSWORD: string;
  PROBE_TOKEN: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const expected = env.PROBE_TOKEN;
    const given = request.headers.get("x-probe-token");
    if (
      typeof expected !== "string" ||
      expected.length < 20 ||
      given === null ||
      !timingSafeEqual(given, expected)
    ) {
      return new Response("Not found", { status: 404 });
    }
    if (typeof env.GMAIL_APP_PASSWORD !== "string" || env.GMAIL_APP_PASSWORD.length === 0) {
      return Response.json({ error: "GMAIL_APP_PASSWORD is not set" }, { status: 503 });
    }

    const started = Date.now();
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      // Google shows app passwords in groups of four; spaces are display only.
      auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, "") },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    client.on("error", () => {
      // Consumed; the catch below reports the outcome.
    });

    try {
      await client.connect();
      // Read-only: this probe must not mark anything as seen.
      const box = await client.mailboxOpen("INBOX", { readOnly: true });
      const result = {
        authenticated: true,
        mailbox: box.path,
        messages: box.exists,
        uidNext: box.uidNext,
        uidValidity: String(box.uidValidity),
        wallMs: Date.now() - started,
        note: "Counts only. No message content was read or returned.",
      };
      await client.logout();
      return Response.json(result);
    } catch (error) {
      const e = error as Record<string, unknown>;
      return Response.json({
        authenticated: false,
        serverResponseCode: e["serverResponseCode"] ?? null,
        responseText: e["responseText"] ?? null,
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        wallMs: Date.now() - started,
      });
    } finally {
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  },
} satisfies ExportedHandler<Env>;
