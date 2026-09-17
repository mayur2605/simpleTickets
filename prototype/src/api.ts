/**
 * Talking to the SimpleTickets server.
 *
 * The dashboard still works WITHOUT a backend: when none answers it keeps its
 * built-in sample data, which is what the browser smoke test exercises and what
 * makes the UI reviewable with nothing running.
 *
 * What changed, and it is the whole point of the local rebuild: there is no
 * token in this file any more. The server is same-origin — it serves this
 * bundle — so the browser holds an HttpOnly session cookie and the bundle holds
 * nothing. Previously `VITE_ADMIN_TOKEN` was compiled into the JavaScript, so
 * anyone who could open the dashboard had full API access and the server could
 * not tell one staff member from another. Now every write is attributed to the
 * signed-in session, server-side, and `author` is not something the client can
 * claim (R06).
 */

/** Optional override for development against a server on another port. */
function envString(key: string): string | undefined {
  const env: unknown = import.meta.env;
  if (typeof env !== "object" || env === null) return undefined;
  const value: unknown = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Empty string means same origin, which is the normal case. */
const API_URL = envString("VITE_API_URL") ?? "";

export interface Identity {
  name: string;
  isAdmin: boolean;
}

export interface ApiTicket {
  id: number;
  subject: string;
  requester: string;
  status: string;
  priority: string;
  owner: string | null;
  response_due: string | null;
  first_response_at: string | null;
  created_at: string;
  updated_at: string;
  messages: number;
  met: boolean;
  overdue: boolean;
  minutesRemaining: number | null;
  minutesOverdue: number | null;
}

export interface ApiSummary {
  total: number;
  overdue: number;
  unassigned: number;
  awaitingFirstResponse: number;
  byStatus: Record<string, number>;
}

export interface ApiMessage {
  id: number;
  direction: string;
  author: string;
  body: string;
  message_id: string | null;
  created_at: string;
}

export interface ApiAttachment {
  id: number;
  filename: string;
  content_type: string;
  bytes: number;
}

export interface ApiStaff {
  name: string;
  email: string | null;
  available: boolean;
  /** Account access (R24). Separate from `available`: see setEnabled. */
  enabled: boolean;
  is_admin: boolean;
  has_password: boolean;
  openTickets: number;
}

/** Someone copied on a ticket (R25). `removed_at` set means no longer on it. */
export interface ApiParticipant {
  address: string;
  added_by: string;
  added_at: string;
  removed_at: string | null;
}

/** One entry in the ticket's audit trail (R08). */
export interface ApiAudit {
  id: number;
  ticket_id: number | null;
  actor: string;
  action: string;
  detail: string | null;
  at: string;
}

/**
 * Outgoing mail this ticket is still waiting on (R28).
 *
 * The dashboard has to show this. A status change hangs off the message that
 * justifies it, so pressing Resolve and seeing "New" is correct and looks
 * broken - and the obvious response is to press it again.
 */
export interface ApiPending {
  id: number;
  intent: string;
  state: string;
  pending_status: string | null;
  last_error: string | null;
}

export interface ApiTemplate {
  id: number;
  name: string;
  body: string;
  /** The status sending this template requests, or null for no change. */
  maps_to: string | null;
}

/** Raised for a 401, so the UI can show the sign-in form rather than an error. */
export class NotSignedIn extends Error {
  constructor() {
    super("Sign-in required");
    this.name = "NotSignedIn";
  }
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    // The session cookie. Without this the browser sends nothing and every
    // call is anonymous.
    credentials: "include",
  });

  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) {
    const detail = await response
      .clone()
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "error" in body
          ? String(body.error)
          : response.statusText,
      )
      .catch(() => response.statusText);
    throw new Error(`${path} failed: ${String(response.status)} ${detail}`);
  }
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is a real backend answering?
 *
 * Asked by calling /api/me rather than by reading a build-time variable,
 * because the honest question is "is a server there", not "was one configured".
 * The JSON shape is checked: with no proxy in front, an unknown path returns
 * the dashboard's own index.html with a 200, and a bundle that took that for a
 * backend would show an empty queue instead of the sample data.
 */
export async function probeBackend(): Promise<{
  live: boolean;
  identity: Identity | null;
}> {
  try {
    const response = await fetch(`${API_URL}/api/me`, {
      credentials: "include",
    });
    const body: unknown = await response.json();
    if (!isRecord(body) || !("signedIn" in body))
      return { live: false, identity: null };
    if (body["signedIn"] !== true) return { live: true, identity: null };
    return {
      live: true,
      identity: {
        name: String(body["name"]),
        isAdmin: body["isAdmin"] === true,
      },
    };
  } catch {
    // No server, or it answered something that was not JSON. Sample data.
    return { live: false, identity: null };
  }
}

/**
 * Step one of sign-in.
 *
 * Returns `null` when the server wants an emailed code as well (R06), which the
 * caller answers with `verifyCode`. Null rather than a thrown error because
 * needing a second factor is a successful first step, not a failure.
 */
export async function login(
  name: string,
  password: string,
): Promise<Identity | null> {
  const body = await call("/api/login", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  if (!isRecord(body)) throw new Error("Unexpected response from /api/login");
  if (body["codeRequired"] === true) return null;
  return { name: String(body["name"]), isAdmin: body["isAdmin"] === true };
}

/** Step two: the six digits that were emailed (R06). */
export async function verifyCode(
  name: string,
  code: string,
): Promise<Identity> {
  const body = await call("/api/login/verify", {
    method: "POST",
    body: JSON.stringify({ name, code }),
  });
  if (!isRecord(body))
    throw new Error("Unexpected response from /api/login/verify");
  return { name: String(body["name"]), isAdmin: body["isAdmin"] === true };
}

export async function logout(): Promise<void> {
  await call("/api/logout", { method: "POST" });
}

export async function fetchTickets(): Promise<{
  tickets: ApiTicket[];
  summary: ApiSummary;
}> {
  const body = await call("/api/tickets");
  if (
    !isRecord(body) ||
    !Array.isArray(body["tickets"]) ||
    !isRecord(body["summary"])
  ) {
    throw new Error("Unexpected response from /api/tickets");
  }
  return {
    tickets: body["tickets"] as ApiTicket[],
    summary: body["summary"] as unknown as ApiSummary,
  };
}

export interface ApiTicketDetail {
  ticket: ApiTicket;
  messages: ApiMessage[];
  attachments: ApiAttachment[];
  participants: ApiParticipant[];
  audit: ApiAudit[];
  pending: ApiPending[];
}

/** Arrays the server may not have sent, rather than a cast that pretends it did. */
function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function fetchTicket(id: number): Promise<ApiTicketDetail> {
  const body = await call(`/api/tickets/${String(id)}`);
  if (
    !isRecord(body) ||
    !isRecord(body["ticket"]) ||
    !Array.isArray(body["messages"])
  ) {
    throw new Error("Unexpected response from /api/tickets/:id");
  }
  return {
    ticket: body["ticket"] as unknown as ApiTicket,
    messages: body["messages"] as ApiMessage[],
    attachments: list<ApiAttachment>(body["attachments"]),
    participants: list<ApiParticipant>(body["participants"]),
    audit: list<ApiAudit>(body["audit"]),
    pending: list<ApiPending>(body["pending"]),
  };
}

export async function fetchStaff(): Promise<ApiStaff[]> {
  const body = await call("/api/staff");
  if (!isRecord(body) || !Array.isArray(body["staff"])) {
    throw new Error("Unexpected response from /api/staff");
  }
  return body["staff"] as ApiStaff[];
}

/**
 * Note that none of these take an author. The server takes it from the session;
 * a client that supplied one would be claiming to be someone.
 */
export async function sendReply(
  id: number,
  body: string,
  templateId?: number,
): Promise<void> {
  // The BODY is always what is on screen, never the stored template. R24 lets
  // staff edit a selected reply before sending; only the template's status
  // mapping is read server-side.
  await call(`/api/tickets/${String(id)}/reply`, {
    method: "POST",
    body: JSON.stringify(
      templateId === undefined ? { body } : { body, templateId },
    ),
  });
}

export async function addNote(id: number, body: string): Promise<void> {
  await call(`/api/tickets/${String(id)}/note`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

/**
 * Ask for a status change. The server decides whether it applies now or waits
 * for the mail server to accept the message that justifies it (R28) — which is
 * why the caller re-reads rather than assuming.
 */
export async function setStatus(
  id: number,
  status: string,
  body: string,
): Promise<void> {
  await call(`/api/tickets/${String(id)}/status`, {
    method: "POST",
    body: JSON.stringify({ status, body }),
  });
}

/** R11, R22: a signal to whoever works the queue. It changes no deadline. */
export async function setPriority(id: number, priority: string): Promise<void> {
  await call(`/api/tickets/${String(id)}/priority`, {
    method: "POST",
    body: JSON.stringify({ priority }),
  });
}

export async function assign(id: number, owner: string | null): Promise<void> {
  await call(`/api/tickets/${String(id)}/assign`, {
    method: "POST",
    body: JSON.stringify({ owner }),
  });
}

export async function fetchTemplates(): Promise<ApiTemplate[]> {
  const body = await call("/api/templates");
  if (!isRecord(body) || !Array.isArray(body["templates"])) {
    throw new Error("Unexpected response from /api/templates");
  }
  return body["templates"] as ApiTemplate[];
}

/** Admin only, enforced server-side. `id` absent creates, present replaces. */
export async function saveTemplate(template: {
  id?: number;
  name: string;
  body: string;
  mapsTo: string | null;
}): Promise<void> {
  const { id, ...rest } = template;
  await call(
    id === undefined ? "/api/templates" : `/api/templates/${String(id)}`,
    {
      method: "POST",
      body: JSON.stringify(rest),
    },
  );
}

export async function deleteTemplate(id: number): Promise<void> {
  await call(`/api/templates/${String(id)}`, { method: "DELETE" });
}

/** R25: add company colleagues to a ticket. External addresses are refused. */
export async function addParticipants(
  id: number,
  addresses: string[],
): Promise<{ added: string[]; refused: string[] }> {
  const body = await call(`/api/tickets/${String(id)}/participants`, {
    method: "POST",
    body: JSON.stringify({ add: addresses }),
  });
  if (!isRecord(body)) throw new Error("Unexpected response from participants");
  return {
    added: list<string>(body["added"]),
    refused: list<string>(body["refused"]),
  };
}

export async function removeParticipant(
  id: number,
  address: string,
): Promise<void> {
  await call(`/api/tickets/${String(id)}/participants`, {
    method: "POST",
    body: JSON.stringify({ remove: address }),
  });
}

/** Admin only. `available` stops new work; `enabled` is account access (R24). */
export async function setStaffFlag(
  name: string,
  flag: { available: boolean } | { enabled: boolean },
): Promise<void> {
  await call("/api/staff", {
    method: "POST",
    body: JSON.stringify({ name, ...flag }),
  });
}

/**
 * Put a bounced, failed or ambiguous message back in the queue (R28).
 *
 * This is also what re-anchors an auto-close clock: the acceptance is cleared,
 * so a resent resolution counts its 72 hours from the delivery that arrived.
 */
export async function resend(outboxId: number): Promise<void> {
  await call(`/api/outbox/${String(outboxId)}/resend`, { method: "POST" });
}

/** Where to download an attachment. Same origin, so the cookie goes with it. */
export function attachmentUrl(id: number): string {
  return `${API_URL}/api/attachments/${String(id)}`;
}
