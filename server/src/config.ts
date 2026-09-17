/**
 * Configuration, read once from the environment.
 *
 * Loaded by `node --env-file-if-exists=.env` — Node reads .env natively, so
 * there is no dotenv dependency and no import-order trap where a module reads
 * process.env before the file has been parsed.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${name}. See env.example.`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export interface Config {
  databaseUrl: string;
  port: number;
  gmailUser: string;
  gmailAppPassword: string;
  supportAddress: string;
  allowedDomain: string;
  adminToken: string;
  storageDir: string;
  backupDir: string;
  /**
   * Whether the outbox is allowed to open an SMTP connection.
   *
   * Off unless MAIL_SEND=on, and off is the default on purpose: a developer
   * running this against the real mailbox must not be able to send a duplicate
   * acknowledgement to a real employee by accident. With it off, intents are
   * still written, claimed and rendered — everything except the wire.
   */
  mailSend: boolean;
  /**
   * Directory holding pg_dump and pg_restore.
   *
   * Homebrew installs PostgreSQL keg-only, so these are NOT on PATH by
   * default — and a backup that fails nightly with "command not found" is
   * exactly the kind of failure nobody notices until they need the backup.
   */
  pgBin: string;
  /** Where staff read tickets. Every notification links here (R15). */
  dashboardUrl: string;
  /**
   * The address outgoing mail is From.
   *
   * The Gmail account, NOT `supportAddress`, and the difference is the whole
   * point. `support@allcheckservices.com` is where employees write TO; it is not
   * an address this system is entitled to write AS.
   *
   * Sending as it would mean putting a domain we do not speak for in a From
   * header, from Gmail's servers, with nothing published to say that is allowed
   * — which is exactly what DMARC exists to catch, and what gets mail filtered.
   * Earning the right to it needs a DNS record, an SPF include, a DKIM key or
   * the domain's own SMTP server, and the standing decision is to leave
   * `allcheckservices.com` alone (PRD open point 5).
   *
   * So every outgoing message says plainly who actually sent it. The ticket
   * number in the subject and the threading headers are what tie the
   * conversation together, and they do not care what the From address is.
   *
   * FROM_ADDRESS overrides, for whoever reverses that decision later.
   */
  fromAddress: string;
  /**
   * Whether sign-in requires an emailed code as well as a password (R06).
   *
   * OFF by default, and that default is the safe one rather than the lax one:
   * the code is sent over SMTP, so turning this on while `MAIL_SEND` is off
   * would lock every staff member out of a system that cannot tell them why.
   * `mailCredentials()` is required for it, and main.ts refuses to start with
   * it on and no way to send.
   */
  loginCodes: boolean;
}

export const config: Config = {
  databaseUrl: optional("DATABASE_URL", "postgresql://localhost:5432/simpletickets"),
  port: Number(optional("PORT", "8787")),
  gmailUser: optional("GMAIL_USER", ""),
  gmailAppPassword: optional("GMAIL_APP_PASSWORD", ""),
  supportAddress: optional("SUPPORT_ADDRESS", "support@allcheckservices.com"),
  allowedDomain: optional("ALLOWED_DOMAIN", "allcheckservices.com"),
  adminToken: optional("ADMIN_TOKEN", ""),
  storageDir: optional("STORAGE_DIR", "./var/storage"),
  backupDir: optional("BACKUP_DIR", "./var/backups"),
  mailSend: optional("MAIL_SEND", "off") === "on",
  pgBin: optional("PG_BIN", ""),
  dashboardUrl: optional("DASHBOARD_URL", `http://localhost:${optional("PORT", "8787")}`),
  loginCodes: optional("LOGIN_CODES", "off") === "on",
  fromAddress:
    optional("FROM_ADDRESS", "") ||
    optional("GMAIL_USER", "") ||
    optional("SUPPORT_ADDRESS", "support@allcheckservices.com"),
};

/** Mail credentials are only required by the parts that actually touch mail. */
export function mailCredentials(): { user: string; password: string } {
  return { user: required("GMAIL_USER"), password: required("GMAIL_APP_PASSWORD") };
}
