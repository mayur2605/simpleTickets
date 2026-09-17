/**
 * SMTP submission over Gmail, port 465, plus the reply parsing it depends on.
 *
 * Parsing and transport were two files on Cloudflare because
 * `cloudflare:sockets` could not be imported under vitest, which made anything
 * sharing a file with it permanently untestable. `node:tls` has no such
 * problem, so they are one file again — the split bought nothing but distance
 * between a function and its test.
 *
 * Port 465 is implicit TLS: the session is encrypted from the first byte and
 * there is no STARTTLS upgrade to get wrong. Nothing here logs the password or
 * the message body.
 */
import { connect, type TLSSocket } from "node:tls";
import { buildMessage, type OutgoingMessage } from "./mime.ts";

export class SmtpError extends Error {
  readonly step: string;
  readonly code: string;
  constructor(step: string, code: string, detail: string) {
    super(`SMTP ${step} failed with ${code}: ${detail}`);
    this.name = "SmtpError";
    this.step = step;
    this.code = code;
  }
}

/**
 * A reply is complete when its LAST line starts with three digits and a SPACE.
 * A hyphen after the digits means more lines follow; stopping early would leave
 * the remainder in the buffer and desynchronise every later command.
 */
export function isReplyComplete(buffer: string): boolean {
  const lines = buffer.split("\r\n").filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  return last !== undefined && /^\d{3} /.test(last) && buffer.endsWith("\r\n");
}

/** The status code, taken from the final line of a possibly multi-line reply. */
export function replyCode(buffer: string): string {
  const lines = buffer.split("\r\n").filter((line) => line.length > 0);
  const last = lines[lines.length - 1] ?? "";
  return last.slice(0, 3);
}

export interface SmtpAcceptance {
  /**
   * When the server accepted the message. R28 gates status transitions on this
   * moment, and the 72-hour auto-close clock is anchored to it.
   */
  acceptedAt: string;
  /** The server's reply to end-of-DATA; Gmail includes a queue id here. */
  reply: string;
}

export interface SendOptions {
  user: string;
  appPassword: string;
  message: OutgoingMessage;
  /** Envelope sender. Bounces return here, not to the From header. */
  envelopeFrom: string;
  envelopeTo: string[];
  host?: string;
  port?: number;
  /** Overall deadline. A hung server must not hold a poller forever. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** A socket wrapper that turns the event stream into awaitable reads. */
class Dialogue {
  #buffer = "";
  #waiting: (() => void) | null = null;
  #failure: Error | null = null;
  readonly #socket: TLSSocket;

  constructor(socket: TLSSocket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.#wake();
    });
    // A socket that ends or errors mid-dialogue must wake the pending read,
    // or the send hangs until the overall timeout instead of failing now.
    socket.on("error", (error: Error) => {
      this.#failure = error;
      this.#wake();
    });
    socket.on("close", () => {
      this.#failure ??= new Error("SMTP connection closed unexpectedly.");
      this.#wake();
    });
  }

  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.();
  }

  async write(text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(text, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async read(step: string, expected: string): Promise<string> {
    while (!isReplyComplete(this.#buffer)) {
      if (this.#failure !== null) {
        throw new SmtpError(step, "000", this.#failure.message);
      }
      await new Promise<void>((resolve) => {
        this.#waiting = resolve;
      });
    }
    const reply = this.#buffer;
    this.#buffer = "";
    const code = replyCode(reply);
    if (code !== expected) throw new SmtpError(step, code, reply.trim().slice(0, 200));
    return reply;
  }

  async send(line: string, step: string, expected: string): Promise<string> {
    await this.write(`${line}\r\n`);
    return this.read(step, expected);
  }
}

/**
 * Sends one message and returns its acceptance record. Throws SmtpError on an
 * unexpected status, so a caller can tell "the server refused it" from a
 * network failure and decide whether retrying is safe.
 */
export async function sendMessage(options: SendOptions): Promise<SmtpAcceptance> {
  const host = options.host ?? "smtp.gmail.com";
  const port = options.port ?? 465;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const candidate = connect({ host, port, servername: host }, () => {
      resolve(candidate);
    });
    candidate.setTimeout(timeoutMs, () => {
      candidate.destroy(new Error("SMTP connect timed out."));
    });
    candidate.once("error", reject);
  });

  const dialogue = new Dialogue(socket);
  try {
    await dialogue.read("greeting", "220");
    await dialogue.send("EHLO simpletickets.invalid", "EHLO", "250");

    await dialogue.send("AUTH LOGIN", "AUTH", "334");
    await dialogue.send(Buffer.from(options.user).toString("base64"), "AUTH username", "334");
    // The password is written and never recorded. SmtpError carries only the
    // server's reply, which does not echo it.
    await dialogue.send(
      Buffer.from(options.appPassword).toString("base64"),
      "AUTH password",
      "235",
    );

    await dialogue.send(`MAIL FROM:<${options.envelopeFrom}>`, "MAIL FROM", "250");
    for (const recipient of options.envelopeTo) {
      await dialogue.send(`RCPT TO:<${recipient}>`, "RCPT TO", "250");
    }

    await dialogue.send("DATA", "DATA", "354");
    // buildMessage has already dot-stuffed the body, so the terminator below is
    // the only bare "." in the stream.
    await dialogue.write(`${buildMessage(options.message)}\r\n.\r\n`);
    const reply = await dialogue.read("end of DATA", "250");
    const acceptedAt = new Date().toISOString();

    try {
      await dialogue.send("QUIT", "QUIT", "221");
    } catch {
      // The message is already accepted. A rude disconnect at QUIT does not
      // un-send it, so this must never turn an acceptance into a failure.
    }

    return { acceptedAt, reply: reply.trim() };
  } finally {
    socket.destroy();
  }
}
