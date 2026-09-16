/**
 * SMTP submission over Gmail, port 465.
 *
 * Proved on 17 September 2026: a Worker authenticates to smtp.gmail.com:465
 * with the same App Password used for IMAP ingestion (235, 1416 ms). See
 * docs/stack-validation.md.
 *
 * Port 465 is implicit TLS, so the session is encrypted from the first byte and
 * there is no STARTTLS upgrade to get wrong. Nothing here logs the password or
 * the message body.
 *
 * Reply parsing lives in ./smtp so it can be unit tested; `cloudflare:sockets`
 * cannot be imported outside the Workers runtime.
 */
import { connect } from "cloudflare:sockets";
import { buildMessage, type OutgoingMessage } from "./mime";
import { SmtpError, isReplyComplete, replyCode } from "./smtp";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
}

/**
 * Sends one message and returns its acceptance record. Throws SmtpError on an
 * unexpected status, so a caller can tell "the server refused it" from a
 * network failure and decide whether retrying is safe.
 */
export async function sendMessage(options: SendOptions): Promise<SmtpAcceptance> {
  const socket = connect(
    { hostname: "smtp.gmail.com", port: 465 },
    { secureTransport: "on", allowHalfOpen: false },
  );
  // cloudflare:sockets types its streams as `any`-parameterised, so these two
  // assignments cannot be made safe without lying about the type. Narrowed to
  // Uint8Array here, which is what workerd actually delivers; every read is
  // decoded through TextDecoder, which rejects anything else at runtime.
  /* eslint-disable @typescript-eslint/no-unsafe-assignment */
  const writer: WritableStreamDefaultWriter<Uint8Array> = socket.writable.getWriter();
  const reader: ReadableStreamDefaultReader<Uint8Array> = socket.readable.getReader();
  /* eslint-enable @typescript-eslint/no-unsafe-assignment */

  const writeRaw = async (text: string): Promise<void> => {
    await writer.write(encoder.encode(text));
  };

  const read = async (step: string, expected: string): Promise<string> => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (isReplyComplete(buffer)) break;
    }
    const code = replyCode(buffer);
    if (code !== expected) {
      throw new SmtpError(step, code, buffer.trim().slice(0, 200));
    }
    return buffer;
  };

  const send = async (line: string, step: string, expected: string): Promise<string> => {
    await writeRaw(`${line}\r\n`);
    return read(step, expected);
  };

  try {
    await read("greeting", "220");
    await send("EHLO simpletickets.invalid", "EHLO", "250");

    await send("AUTH LOGIN", "AUTH", "334");
    await send(btoa(options.user), "AUTH username", "334");
    // The password is written and never recorded. SmtpError carries only the
    // server's reply, which does not echo it.
    await send(btoa(options.appPassword), "AUTH password", "235");

    await send(`MAIL FROM:<${options.envelopeFrom}>`, "MAIL FROM", "250");
    for (const recipient of options.envelopeTo) {
      await send(`RCPT TO:<${recipient}>`, "RCPT TO", "250");
    }

    await send("DATA", "DATA", "354");
    // buildMessage has already dot-stuffed the body, so the terminator below is
    // the only bare "." in the stream.
    await writeRaw(`${buildMessage(options.message)}\r\n.\r\n`);
    const reply = await read("end of DATA", "250");
    const acceptedAt = new Date().toISOString();

    try {
      await send("QUIT", "QUIT", "221");
    } catch {
      // The message is already accepted. A rude disconnect at QUIT does not
      // un-send it, so this must never turn an acceptance into a failure.
    }

    return { acceptedAt, reply: reply.trim() };
  } finally {
    try {
      await socket.close();
    } catch {
      // A socket that already failed cannot be closed cleanly; nothing to do.
    }
  }
}
