/**
 * Throwaway probe: can `imapflow` bundle and run on Workers under
 * nodejs_compat? Deliberately uses invalid credentials. An authentication
 * failure is a PASS - it means the library loaded, opened TLS and completed an
 * IMAP LOGIN exchange. A module or socket error is a FAIL.
 */
import { ImapFlow } from "imapflow";

export default {
  async fetch(): Promise<Response> {
    const started = Date.now();
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: "probe@example.invalid", pass: "not-a-real-password" },
      logger: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    client.on("error", () => {
      // Consumed so an unhandled error does not mask the result.
    });
    try {
      await client.connect();
      await client.logout();
      return Response.json({
        result: "UNEXPECTED: connected with invalid credentials",
        wallMs: Date.now() - started,
      });
    } catch (error) {
      // imapflow attaches its own fields. "Command failed" alone is ambiguous,
      // so surface everything before judging whether the server was reached.
      const e = error as Record<string, unknown>;
      const detail: Record<string, unknown> = {};
      for (const key of [
        "name",
        "message",
        "authenticationFailed",
        "serverResponseCode",
        "responseText",
        "response",
        "code",
        "command",
      ]) {
        if (e[key] !== undefined) detail[key] = e[key];
      }
      // A rejected LOGIN proves the whole stack worked: TLS, greeting, write,
      // tagged response. Only a transport or module failure is a real FAIL.
      const authRejected =
        e["authenticationFailed"] === true ||
        typeof e["responseText"] === "string" ||
        typeof e["serverResponseCode"] === "string";
      return Response.json({
        libraryLoaded: true,
        verdict: authRejected
          ? "PASS - imapflow completed an IMAP login exchange on Workers"
          : "INCONCLUSIVE - see detail",
        detail,
        ownKeys: Object.keys(e),
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
};
