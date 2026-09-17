/**
 * Local file storage. Replaces R2.
 *
 * Two kinds of file live here: the raw RFC822 source of every message we
 * examine, and attachments extracted from them (R12).
 *
 * The single rule that matters: **a filename from an email never becomes a
 * path**. Filenames arrive from outside and "../../.." is a filename. Every
 * stored file is named from a random id we generate; the sender's filename is
 * kept in the database as a label and used only when serving the file back.
 */
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";

/** R12: 5 MB total per email. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export class Storage {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  get root(): string {
    return this.#root;
  }

  /**
   * Resolve a relative path against the storage root, refusing anything that
   * escapes it. Reached with paths out of the database, which are only as
   * trustworthy as whatever wrote them — so this is checked on read as well as
   * on write, not merely at the point of creation.
   */
  absolute(relativePath: string): string {
    const full = resolve(this.#root, relativePath);
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new Error(`Path escapes the storage root: ${relativePath}`);
    }
    return full;
  }

  async #write(relativePath: string, data: Buffer | string): Promise<string> {
    const full = this.absolute(relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    return relativePath;
  }

  /**
   * Archive the raw message. Named by UID under a day folder, so a mailbox with
   * years of history does not end up as one unlistable directory.
   */
  async storeRawMessage(uid: number, source: Buffer | string): Promise<string> {
    const day = new Date().toISOString().slice(0, 10);
    return this.#write(join("raw", day, `${String(uid)}.eml`), source);
  }

  /**
   * Store one attachment. The path is generated, never derived from the
   * sender's filename — see the note at the top of this file.
   */
  async storeAttachment(ticketId: number, content: Buffer): Promise<string> {
    return this.#write(join("attachments", String(ticketId), `${randomUUID()}.bin`), content);
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(this.absolute(relativePath));
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(this.absolute(relativePath));
      return true;
    } catch {
      return false;
    }
  }
}

const CONTROL_CHARACTERS = /[\p{Cc}]/gu;

/**
 * Reduce a sender-supplied filename to something safe to show and to offer as
 * a download name. Not used to build a path — nothing here is.
 */
export function safeFilename(raw: string | null | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(CONTROL_CHARACTERS, "").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".."
    ? "attachment"
    : cleaned.slice(0, 200);
}
