/**
 * SMTP reply parsing. Pure string work: no sockets, no secrets.
 *
 * Kept apart from the transport so it can be unit tested — `cloudflare:sockets`
 * cannot be imported outside the Workers runtime, and this is where the subtle
 * bug lives (multi-line replies), so it is the half that most needs tests.
 */

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
