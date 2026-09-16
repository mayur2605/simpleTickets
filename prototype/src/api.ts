/**
 * Talking to the SimpleTickets worker.
 *
 * The dashboard works WITHOUT this. When no API is configured it keeps its
 * built-in sample data, which is what the browser smoke test exercises and what
 * makes the UI reviewable without a backend. Configure `VITE_API_URL` and
 * `VITE_ADMIN_TOKEN` in `.env.local` to see real tickets instead.
 *
 * SECURITY, and it is not a small one: the admin token ends up in the browser
 * bundle. There is one shared token, so anyone who can open the dashboard has
 * full API access and the server cannot tell one staff member from another.
 * That is acceptable for a local review build and NOT acceptable for staff use.
 * Real per-person sign-in is R06, blocked on the Workers PBKDF2 cap.
 */

// import.meta.env is typed `any`, so read it as unknown and check. A
// mistyped variable name should leave the dashboard on sample data, not
// produce `fetch("undefined/api/tickets")`.
function envString(key: string): string | undefined {
  const env: unknown = import.meta.env;
  if (typeof env !== "object" || env === null) return undefined;
  const value: unknown = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const API_URL = envString("VITE_API_URL");
const ADMIN_TOKEN = envString("VITE_ADMIN_TOKEN");

/** Whether a backend is configured at all. */
export const apiConfigured = (): boolean =>
  typeof API_URL === "string" &&
  API_URL.length > 0 &&
  typeof ADMIN_TOKEN === "string";

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

async function call(path: string, init?: RequestInit): Promise<unknown> {
  if (!apiConfigured()) {
    throw new Error("No API configured.");
  }
  // Built through Headers rather than object spread: HeadersInit can be an
  // array of pairs, and spreading that yields numeric keys instead of headers.
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set("x-admin-token", String(ADMIN_TOKEN));

  const response = await fetch(`${String(API_URL)}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    // The worker answers an unknown route and a bad token identically, so a
    // 404 here genuinely is ambiguous and should say so rather than guess.
    const detail =
      response.status === 404
        ? "not found, or the token is wrong"
        : response.statusText;
    throw new Error(`${path} failed: ${String(response.status)} ${detail}`);
  }
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export async function fetchTicket(
  id: number,
): Promise<{ ticket: ApiTicket; messages: ApiMessage[] }> {
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
  };
}

export async function sendReply(
  id: number,
  body: string,
  author: string,
): Promise<void> {
  await call(`/api/tickets/${String(id)}/reply`, {
    method: "POST",
    body: JSON.stringify({ body, author }),
  });
}

export async function addNote(
  id: number,
  body: string,
  author: string,
): Promise<void> {
  await call(`/api/tickets/${String(id)}/note`, {
    method: "POST",
    body: JSON.stringify({ body, author }),
  });
}
