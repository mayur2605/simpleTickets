import { useEffect, useState, type SyntheticEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  FluentProvider,
  webLightTheme,
  Button,
  Input,
  Select,
  Textarea,
  Field,
  Avatar,
  Badge,
  Table,
  TableHeader,
  TableRow,
  TableHeaderCell,
  TableBody,
  TableCell,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import {
  TicketDiagonal24Regular,
  Search20Regular,
  People24Regular,
  TextBulletListSquare24Regular,
  Mail24Regular,
  ArrowLeft20Regular,
  Add20Regular,
  Delete20Regular,
  Dismiss12Regular,
  CheckmarkCircle20Regular,
  Warning20Regular,
  Attach20Regular,
  Clock24Regular,
  ArrowTrendingLines24Regular,
  PersonClock24Regular,
} from "@fluentui/react-icons";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "./style.css";
import "./brand.css";
import {
  probeBackend,
  login as apiLogin,
  logout as apiLogout,
  fetchTickets,
  fetchTicket,
  fetchStaff,
  fetchTemplates,
  saveTemplate,
  deleteTemplate as apiDeleteTemplate,
  sendReply,
  addNote as postNote,
  setStatus as apiSetStatus,
  assign as apiAssign,
  setPriority as apiSetPriority,
  addParticipants as apiAddParticipants,
  removeParticipant as apiRemoveParticipant,
  setStaffFlag,
  resend as apiResend,
  attachmentUrl,
  NotSignedIn,
  type ApiTicket,
  type ApiStaff,
  type ApiParticipant,
  type ApiAudit,
  type ApiPending,
  type ApiAttachment,
  type Identity,
} from "./api";
type Ticket = {
  id: number;
  title: string;
  person: string;
  status: string;
  priority: string;
  owner: string;
  due: string;
  body: string;
};
/**
 * Turn an API ticket into the shape this UI already speaks.
 *
 * The two differ because the prototype was written before the backend existed.
 * Mapping here rather than renaming everything keeps the change small and the
 * browser smoke test - which drives the UI by its existing labels - intact.
 */
function fromApi(ticket: ApiTicket): Ticket {
  const due =
    ticket.overdue && ticket.minutesOverdue !== null
      ? `Overdue by ${describeMinutes(ticket.minutesOverdue)}`
      : ticket.met
        ? "Responded"
        : ticket.minutesRemaining === null
          ? "No deadline"
          : `Due in ${describeMinutes(ticket.minutesRemaining)}`;
  return {
    id: ticket.id,
    title: ticket.subject,
    person: ticket.requester,
    status: ticket.status,
    priority: ticket.priority,
    // The UI expects a string; an unassigned ticket says so rather than
    // showing an empty cell that reads as a rendering fault.
    owner: ticket.owner ?? "Unassigned",
    due,
    body: "",
  };
}

function describeMinutes(minutes: number): string {
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

const seed: Ticket[] = [
  {
    id: 1048,
    title: "Unable to connect to the office VPN",
    person: "Ananya Rao",
    status: "New",
    priority: "High",
    owner: "Arjun Mehta",
    due: "Overdue · 24 min",
    body: "Hi team, I cannot connect to the office VPN this morning. I have restarted my laptop but still get a connection timeout. Could you help me check this?",
  },
  {
    id: 1047,
    title: "Shared printer is showing offline",
    person: "Rohan Shah",
    status: "In Progress",
    priority: "Normal",
    owner: "Priya Nair",
    due: "Due in 42 min",
    body: "The shared printer on the second floor is showing offline. Other devices seem to be affected too.",
  },
  {
    id: 1046,
    title: "Need access to the finance shared folder",
    person: "Meera Iyer",
    status: "Waiting for Employee",
    priority: "Normal",
    owner: "Arjun Mehta",
    due: "Waiting for reply",
    body: "Please help me access the finance shared folder for the monthly report.",
  },
  {
    id: 1045,
    title: "Zimbra mailbox is almost full",
    person: "Kabir Sethi",
    status: "In Progress",
    priority: "Low",
    owner: "Dev Patel",
    due: "Due in 2 hr",
    body: "My mailbox is showing a storage warning. What is the best way to archive older emails?",
  },
  {
    id: 1044,
    title: "Laptop battery needs a replacement",
    person: "Ishita Das",
    status: "New",
    priority: "Normal",
    owner: "Sana Khan",
    due: "Due in 3 hr",
    body: "My laptop switches off when I unplug the charger. Please check whether the battery can be replaced.",
  },
  {
    id: 1043,
    title: "Teams microphone is not detected",
    person: "Vikram Joshi",
    status: "Resolved",
    priority: "Normal",
    owner: "Neha Jain",
    due: "Auto-close in 2 days",
    body: "The microphone was not detected in Teams. The driver update has fixed the issue.",
  },
  {
    id: 1042,
    title: "Password reset for the shared workstation",
    person: "Nisha Kapoor",
    status: "Closed",
    priority: "Normal",
    owner: "Priya Nair",
    due: "Closed yesterday",
    body: "The password reset is complete and the workstation is accessible again.",
  },
];
/**
 * Sample templates, used when no backend answers. The live ones come from
 * /api/templates and carry an `id`; these do not, which is what tells the save
 * handler whether it is talking to a server or to this array.
 */
type Template = { id?: number; name: string; status: string; body: string };

const initialTemplates: Template[] = [
  {
    name: "Working on it",
    status: "In Progress",
    body: "Hi, we are looking into your issue and will update you as soon as we have more information.",
  },
  {
    name: "Request more details",
    status: "Waiting for Employee",
    body: "Hi, could you share a screenshot of the error and let us know when the issue started? This will help us investigate.",
  },
  {
    name: "Troubleshooting steps",
    status: "Waiting for Employee",
    body: "Hi, please try the following steps and reply with the result:\n\n[Add steps for this issue]",
  },
  {
    name: "Issue resolved",
    status: "Resolved",
    body: "Hi, we have resolved the reported issue. Please reply if you still need help. Otherwise, this ticket will close automatically after 72 hours.",
  },
];
const statuses = [
  "New",
  "In Progress",
  "Waiting for Employee",
  "Resolved",
  "Closed",
];
const staff = [
  "Arjun Mehta",
  "Priya Nair",
  "Dev Patel",
  "Sana Khan",
  "Neha Jain",
] as const;
function Status({ value }: { value: string }) {
  return (
    <span className={"status " + value.toLowerCase().replaceAll(" ", "-")}>
      {value}
    </span>
  );
}
function SignIn({ onSignedIn }: { onSignedIn: (identity: Identity) => void }) {
  const [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    void apiLogin(name, password)
      .then(onSignedIn)
      .catch((problem: unknown) => {
        // The server says the same thing for every failure, on purpose. It is
        // repeated verbatim rather than interpreted here, so the UI cannot
        // accidentally reveal which half was wrong.
        setError(problem instanceof Error ? problem.message : String(problem));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <span className="signin-mark">
          <TicketDiagonal24Regular />
        </span>
        <h1>SimpleTickets</h1>
        <p>Sign in to the IT dashboard.</p>
        <Field label="Name">
          <Input
            value={name}
            autoComplete="username"
            onChange={(_, d) => {
              setName(d.value);
            }}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(_, d) => {
              setPassword(d.value);
            }}
          />
        </Field>
        {error !== "" && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
        <Button
          appearance="primary"
          type="submit"
          disabled={busy || name === ""}
        >
          {busy ? "Signing in..." : "Sign in"}
        </Button>
        <small>
          Accounts are created by an administrator. There is no
          self-registration.
        </small>
      </form>
    </div>
  );
}

function App() {
  // Sample data unless a backend is configured. The smoke test and any
  // design review run with no API and must keep working.
  const [tickets, setTickets] = useState(seed),
    [live, setLive] = useState(false),
    // Who is signed in, according to the server. Null in sample mode too -
    // there is nobody to be when there is no backend.
    [identity, setIdentity] = useState<Identity | null>(null),
    [checking, setChecking] = useState(true),
    [loadError, setLoadError] = useState(""),
    [page, setPage] = useState("All Tickets"),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("All statuses"),
    [overdueOnly, setOverdueOnly] = useState(false),
    [selected, setSelected] = useState<number | null>(null),
    [templates, setTemplates] = useState(initialTemplates),
    [replyDraft, setReplyDraft] = useState(""),
    [noteDraft, setNoteDraft] = useState(""),
    [target, setTarget] = useState("In Progress"),
    [note, setNote] = useState(false),
    [notice, setNotice] = useState(""),
    [messages, setMessages] = useState<
      Record<
        number,
        { text: string; note: boolean; author: string; inbound: boolean }[]
      >
    >({}),
    [editing, setEditing] = useState(-1),
    [name, setName] = useState(""),
    [body, setBody] = useState(""),
    [templateStatus, setTemplateStatus] = useState("No change"),
    // Which template is selected in the composer, so the server can apply its
    // status mapping (R24). -1 is "none"; selecting one never changes status
    // on its own, only sending does.
    [chosenTemplate, setChosenTemplate] = useState(-1),
    // The live ticket's supporting detail. Empty in sample mode, where there
    // is no server to have any.
    [team, setTeam] = useState<ApiStaff[]>([]),
    [participants, setParticipants] = useState<ApiParticipant[]>([]),
    [audit, setAudit] = useState<ApiAudit[]>([]),
    [pending, setPending] = useState<ApiPending[]>([]),
    [attachments, setAttachments] = useState<ApiAttachment[]>([]),
    [newParticipant, setNewParticipant] = useState(""),
    [busy, setBusy] = useState(false);

  // Ask the server who we are before anything else. Three outcomes: no server
  // (sample data), a server and a session (real tickets), or a server and no
  // session (sign in).
  useEffect(() => {
    let cancelled = false;
    void probeBackend().then((result) => {
      if (cancelled) return;
      setLive(result.live);
      setIdentity(result.identity);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!live || identity === null) return;
    let cancelled = false;
    void fetchTickets()
      .then((result) => {
        if (cancelled) return;
        setTickets(result.tickets.map(fromApi));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof NotSignedIn) {
          // The session expired while the page was open.
          setIdentity(null);
          return;
        }
        // Deliberately does NOT fall back to sample data on failure. Showing
        // invented tickets when the real ones cannot be loaded would be worse
        // than showing nothing: IT would work a queue that is not real.
        setTickets([]);
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [live, identity]);
  // Templates and the team, once. Both are shared state that changes rarely,
  // and both fall back to the sample arrays when no server answers.
  useEffect(() => {
    if (!live || identity === null) return;
    let cancelled = false;
    void Promise.all([fetchTemplates(), fetchStaff()])
      .then(([saved, people]) => {
        if (cancelled) return;
        setTemplates(
          saved.map((t) => ({
            id: t.id,
            name: t.name,
            body: t.body,
            status: t.maps_to ?? "No change",
          })),
        );
        setTeam(people);
      })
      .catch(() => {
        // Not fatal: the queue is what matters, and a failure here leaves the
        // sample templates rather than an empty picker.
      });
    return () => {
      cancelled = true;
    };
  }, [live, identity]);

  // A live ticket's history comes from the server. Without this the detail
  // view would show the in-memory sample conversation beside a real ticket,
  // which is the worst of both: it looks like data and is not.
  useEffect(() => {
    if (!live || identity === null || selected === null) return;
    let cancelled = false;
    void fetchTicket(selected)
      .then((result) => {
        if (cancelled) return;
        setMessages((previous) => ({
          ...previous,
          [selected]: result.messages.map((m) => ({
            text: m.body,
            note: m.direction === "note",
            author: m.author,
            inbound: m.direction === "inbound",
          })),
        }));
        setParticipants(result.participants);
        setAudit(result.audit);
        setPending(result.pending);
        setAttachments(result.attachments);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setNotice(
          `Could not load this conversation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [live, identity, selected]);

  /**
   * Re-read the ticket and the queue after a write.
   *
   * Never patched locally, because the server decides what actually happened:
   * under R28 a status change rides on the message that justifies it, so
   * optimistically showing "Resolved" would be wrong until the mail server
   * accepts it - which it may never do.
   */
  async function refresh(ticketId: number): Promise<void> {
    const [detail, list] = await Promise.all([
      fetchTicket(ticketId),
      fetchTickets(),
    ]);
    setMessages((previous) => ({
      ...previous,
      [ticketId]: detail.messages.map((m) => ({
        text: m.body,
        note: m.direction === "note",
        author: m.author,
        inbound: m.direction === "inbound",
      })),
    }));
    setParticipants(detail.participants);
    setAudit(detail.audit);
    setPending(detail.pending);
    setAttachments(detail.attachments);
    setTickets(list.tickets.map(fromApi));
  }

  /**
   * Save the template list.
   *
   * In sample mode this is the array and nothing else — the smoke test and any
   * design review depend on that still working with no server. Live, the server
   * is the record and the local list is refreshed from it afterwards, so a
   * refused write cannot leave the screen showing something that was not saved.
   */
  function saveTemplates(
    next: Template[],
    write:
      | {
          save: {
            id?: number;
            name: string;
            body: string;
            mapsTo: string | null;
          };
        }
      | { deleteId: number }
      | null,
  ) {
    setEditing(-1);
    if (!live || write === null) {
      setTemplates(next);
      setNotice("Template saved for this preview.");
      return;
    }
    setBusy(true);
    void (
      "save" in write
        ? saveTemplate(write.save)
        : apiDeleteTemplate(write.deleteId)
    )
      .then(fetchTemplates)
      .then((saved) => {
        setTemplates(
          saved.map((t) => ({
            id: t.id,
            name: t.name,
            body: t.body,
            status: t.maps_to ?? "No change",
          })),
        );
        setNotice(
          "save" in write
            ? "Template saved. Messages already sent are unchanged."
            : "Template deleted. Messages already sent are unchanged.",
        );
      })
      .catch((error: unknown) => {
        setNotice(
          `Not saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }

  /**
   * Change a staff member's availability or account access (R24).
   *
   * Re-reads the whole queue afterwards, not just the team: marking someone
   * unavailable moves their open tickets, so the list on screen is stale the
   * moment this returns.
   */
  function changeStaff(
    who: string,
    flag: { available: boolean } | { enabled: boolean },
  ) {
    setBusy(true);
    void setStaffFlag(who, flag)
      .then(async () => {
        const [people, list] = await Promise.all([
          fetchStaff(),
          fetchTickets(),
        ]);
        setTeam(people);
        setTickets(list.tickets.map(fromApi));
        setNotice(
          "available" in flag
            ? flag.available
              ? `${who} is available again. Unassigned tickets have been shared out.`
              : `${who} is unavailable. Their open tickets have moved and the new owners were told.`
            : flag.enabled
              ? `${who} can sign in again. Their old tickets stayed where they were moved.`
              : `${who}'s account is disabled. They are signed out and their open tickets have moved.`,
        );
      })
      .catch((error: unknown) => {
        setNotice(
          `Not saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }

  /** Run a write, report what went wrong, and never leave the UI stuck busy. */
  function act(ticketId: number, work: () => Promise<void>, done: string) {
    setBusy(true);
    void work()
      .then(() => refresh(ticketId))
      .then(() => {
        setNotice(done);
      })
      .catch((error: unknown) => {
        setNotice(
          `Not saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        setBusy(false);
      });
  }

  // The person the dashboard is acting as. In sample mode there is no session,
  // so the first sample name stands in - it is a demo, and it says so.
  const me = identity?.name ?? staff[0];
  const draft = note ? noteDraft : replyDraft;
  const setDraft = note ? setNoteDraft : setReplyDraft;
  const current = tickets.find((t) => t.id === selected);
  // Real staff names once a server answers, the sample five otherwise. An
  // unavailable or disabled colleague is still listed: a ticket can be handed
  // to somebody on leave deliberately, it just is not handed to them
  // automatically.
  const owners = live && team.length > 0 ? team.map((s) => s.name) : [...staff];
  const onTicket = participants.filter((person) => person.removed_at === null);
  // R28: outgoing mail this ticket is still waiting on, and anything that
  // failed. Pressing Resolve and seeing "New" is correct and looks broken.
  const waiting = pending.filter(
    (item) => item.state === "pending" || item.state === "sending",
  );
  const stuck = pending.filter(
    (item) => item.state !== "pending" && item.state !== "sending",
  );
  const open = tickets.filter(
    (t) => !["Resolved", "Closed"].includes(t.status),
  );
  const visible = tickets.filter(
    (t) =>
      (!overdueOnly || t.due.startsWith("Overdue")) &&
      (page !== "My Tickets" || t.owner === me) &&
      (filter === "All statuses" || t.status === filter) &&
      `${String(t.id)} ${t.title} ${t.person} ${t.person.toLowerCase().replaceAll(" ", ".")}@allcheckservices.com`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  function navigate(p: string) {
    setPage(p);
    setSelected(null);
    setNotice("");
    setEditing(-1);
    setOverdueOnly(false);
  }
  function send() {
    if (!current || !draft.trim() || draft.includes("[Add steps")) return;

    if (live) {
      const ticketId = current.id;
      const text = draft;
      const isNote = note;
      // The selected template's id, so the server applies its status mapping.
      // The BODY is whatever is on screen: R24 lets staff edit a selected reply
      // before sending, and that edit must reach the employee.
      const templateId = templates[chosenTemplate]?.id;
      // A status the user picked by hand, which the template picker clears.
      // Three shapes of send, and the server decides what each means:
      //   a note, which never touches the outbox;
      //   a template, whose mapping the server reads from the saved row;
      //   a status change, which is delivery-gated (R28).
      const wanted = target === current.status ? null : target;
      setDraft("");
      setChosenTemplate(-1);
      setNotice(isNote ? "Adding note..." : "Queueing reply...");
      act(
        ticketId,
        () =>
          isNote
            ? postNote(ticketId, text)
            : templateId === undefined && wanted !== null
              ? apiSetStatus(ticketId, wanted, text)
              : sendReply(ticketId, text, templateId),
        isNote
          ? "Internal note added. It is never emailed to the employee."
          : wanted === null
            ? "Reply queued. It is sent on the next poll, within two minutes."
            : `Reply queued. The ticket becomes ${wanted} when the mail server accepts it.`,
      );
      return;
    }

    setMessages({
      ...messages,
      [current.id]: [
        ...(messages[current.id] || []),
        { text: draft, note, author: me, inbound: false },
      ],
    });
    if (!note)
      setTickets(
        tickets.map((t) =>
          t.id === current.id
            ? {
                ...t,
                status: target,
                due:
                  target === "Waiting for Employee"
                    ? "Waiting for reply"
                    : target === "Resolved"
                      ? "Auto-close in 72 hr"
                      : "Response sent",
              }
            : t,
        ),
      );
    setDraft("");
    setNotice(
      note
        ? "Internal note added to this preview."
        : "Reply saved in this preview. No email was sent.",
    );
  }
  return (
    <FluentProvider
      theme={{
        ...webLightTheme,
        fontFamilyBase: "Geist, sans-serif",
        fontFamilyNumeric: "Geist, sans-serif",
        colorBrandBackground: "#B54720",
        colorBrandBackgroundHover: "#963916",
        colorBrandBackgroundPressed: "#7C3015",
        colorBrandForeground1: "#B54720",
        colorBrandForeground2: "#963916",
        colorBrandForegroundLink: "#B54720",
        colorBrandForegroundLinkHover: "#963916",
        colorBrandStroke1: "#B54720",
        colorBrandStroke2: "#E9C2B4",
        colorBrandBackground2: "#FBEDE7",
        colorCompoundBrandBackground: "#B54720",
        colorCompoundBrandBackgroundHover: "#963916",
        colorCompoundBrandBackgroundPressed: "#7C3015",
        colorCompoundBrandForeground1: "#B54720",
        colorCompoundBrandStroke: "#B54720",
        colorStrokeFocus2: "#B54720",
      }}
    >
      {checking ? null : live && identity === null ? (
        <SignIn
          onSignedIn={(who) => {
            setIdentity(who);
          }}
        />
      ) : (
        <div className="app">
          <aside>
            <button
              className="brand"
              onClick={() => {
                navigate("All Tickets");
              }}
            >
              <TicketDiagonal24Regular />
              <span>
                SimpleTickets
                <span className="brand-sub">A LITTLE LESS FRICTION.</span>
              </span>
            </button>
            <div className="nav-label">WORKSPACE</div>
            <nav>
              {["All Tickets", "My Tickets", "Reply Templates", "Team"].map(
                (p, i) => (
                  <button
                    key={p}
                    className={page === p ? "nav active" : "nav"}
                    aria-current={page === p ? "page" : undefined}
                    onClick={() => {
                      navigate(p);
                    }}
                  >
                    {i < 2 ? (
                      <TextBulletListSquare24Regular />
                    ) : i === 2 ? (
                      <Mail24Regular />
                    ) : (
                      <People24Regular />
                    )}
                    <span>{p}</span>
                    {i === 0 && <b>{tickets.length}</b>}
                  </button>
                ),
              )}
            </nav>
            <div className="sidebar-note">
              <span className="online" />
              Email-first support<p>One inbox. A connected IT team.</p>
            </div>
            <div className="profile">
              <Avatar name={me} size={32} />
              <div>
                <strong>{me}</strong>
                <small>
                  {identity === null
                    ? "IT administrator · Demo"
                    : `${identity.isAdmin ? "Administrator" : "IT staff"} · Signed in`}
                </small>
              </div>
              {identity !== null && (
                <Button
                  size="small"
                  appearance="subtle"
                  onClick={() => {
                    void apiLogout().then(() => {
                      setIdentity(null);
                      setTickets([]);
                    });
                  }}
                >
                  Sign out
                </Button>
              )}
            </div>
          </aside>
          <div className="workspace">
            <header>
              <span className="breadcrumb">
                <span className="breadcrumb-mark">
                  <TicketDiagonal24Regular />
                </span>{" "}
                Workspace <span className="slash">/</span>
                <strong>{page}</strong>
              </span>
              <Badge appearance="tint" color="informative">
                Interactive preview
              </Badge>
            </header>
            <main>
              {loadError ? (
                <div className="preview" role="alert">
                  Could not load tickets: {loadError}. Nothing is shown rather
                  than sample data, so this queue is never mistaken for real.
                </div>
              ) : live ? (
                <div className="preview">
                  Live tickets from the support mailbox. Replies here send real
                  email.
                </div>
              ) : (
                <div className="preview">
                  Sample data only. Changes last until you refresh. No emails
                  are sent.
                </div>
              )}
              {notice && (
                <div className="notice" role="status">
                  <CheckmarkCircle20Regular />
                  {notice}
                  <Button
                    size="small"
                    appearance="transparent"
                    onClick={() => {
                      setNotice("");
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
              {current ? (
                <>
                  <Button
                    icon={<ArrowLeft20Regular />}
                    appearance="subtle"
                    onClick={() => {
                      setSelected(null);
                    }}
                  >
                    Back to tickets
                  </Button>
                  <div className="detail-heading">
                    <span className="ticket-id">ST-{current.id}</span>
                    <h1>{current.title}</h1>
                    <Status value={current.status} />
                  </div>
                  {waiting.length > 0 && (
                    <div className="notice pending" role="status">
                      <Clock24Regular />
                      {waiting.some((item) => item.pending_status !== null)
                        ? `Waiting for the mail server before this becomes ${
                            waiting.find((item) => item.pending_status !== null)
                              ?.pending_status ?? ""
                          }. The status changes when the message is accepted, not before.`
                        : "A reply is queued and goes out on the next poll."}
                    </div>
                  )}
                  {stuck.map((item) => (
                    <div className="notice failed" role="alert" key={item.id}>
                      <Warning20Regular />
                      This ticket&rsquo;s {item.intent} is {item.state}
                      {item.last_error === null ? "" : `: ${item.last_error}`}.
                      {item.pending_status === null
                        ? ""
                        : ` The ticket stays ${current.status} until it is delivered.`}
                      <Button
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          act(
                            current.id,
                            () => apiResend(item.id),
                            "Queued to send again. Any waiting status change rides on the new delivery.",
                          );
                        }}
                      >
                        Send again
                      </Button>
                    </div>
                  ))}
                  <div className="detail-grid">
                    <section className="panel conversation">
                      <h2>Conversation</h2>
                      <article>
                        <div className="person">
                          <Avatar name={current.person} size={32} />
                          <div>
                            <strong>{current.person}</strong>
                            <small>
                              To support@allcheckservices.com · Sample message
                            </small>
                          </div>
                        </div>
                        <p>{current.body}</p>
                      </article>
                      {(messages[current.id] || []).map((m, i) => (
                        <article
                          key={i}
                          className={
                            m.note
                              ? "internal"
                              : m.inbound
                                ? "from-employee"
                                : ""
                          }
                        >
                          <strong>
                            {m.author} ·{" "}
                            {m.note
                              ? "Internal note"
                              : m.inbound
                                ? "From employee"
                                : "Public reply"}
                          </strong>
                          <p className="preserve">{m.text}</p>
                        </article>
                      ))}
                      <div className="composer">
                        <div className="composer-tabs">
                          <Button
                            appearance={!note ? "primary" : "subtle"}
                            onClick={() => {
                              setNote(false);
                            }}
                          >
                            Reply to employee
                          </Button>
                          <Button
                            appearance={note ? "primary" : "subtle"}
                            onClick={() => {
                              setNote(true);
                            }}
                          >
                            Internal note
                          </Button>
                        </div>
                        {!note && (
                          <Field label="Use a reply template">
                            <Select
                              aria-label="Reply template"
                              value={
                                chosenTemplate === -1
                                  ? ""
                                  : String(chosenTemplate)
                              }
                              onChange={(e) => {
                                const index = Number(e.target.value);
                                const t = templates[index];
                                if (t) {
                                  // Selecting fills the draft and PREVIEWS the
                                  // status (R24: "Show the resulting status
                                  // before sending"). It changes nothing until
                                  // Send.
                                  setChosenTemplate(index);
                                  setDraft(t.body);
                                  setTarget(
                                    t.status === "No change"
                                      ? current.status
                                      : t.status,
                                  );
                                }
                              }}
                            >
                              <option value="" disabled>
                                Choose a saved reply
                              </option>
                              {templates.map((t, i) => (
                                <option key={i} value={i}>
                                  {t.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        )}
                        <Field label={note ? "Visible only to IT" : "Message"}>
                          <Textarea
                            resize="vertical"
                            rows={5}
                            value={draft}
                            onChange={(_, d) => {
                              setDraft(d.value);
                            }}
                            placeholder={
                              note
                                ? "Add context for the team…"
                                : "Write a reply or choose a template…"
                            }
                          />
                        </Field>
                        {draft.includes("[Add steps") && (
                          <p className="error">
                            Replace the placeholder with troubleshooting steps
                            before sending.
                          </p>
                        )}
                        <div className="send-row">
                          {!note && (
                            <Field
                              label="Status after sending"
                              {...(live && target !== current.status
                                ? {
                                    hint: "Applied when the mail server accepts this message (R28).",
                                  }
                                : {})}
                            >
                              <Select
                                value={target}
                                onChange={(e) => {
                                  setTarget(e.target.value);
                                  // A status chosen by hand overrides whichever
                                  // template was picked, so the server is not
                                  // sent a mapping the user has just replaced.
                                  setChosenTemplate(-1);
                                }}
                              >
                                {statuses.map((s) => (
                                  <option key={s}>{s}</option>
                                ))}
                              </Select>
                            </Field>
                          )}
                          <Button
                            appearance="primary"
                            disabled={
                              busy ||
                              !draft.trim() ||
                              draft.includes("[Add steps")
                            }
                            onClick={send}
                          >
                            {note
                              ? "Add internal note"
                              : live
                                ? "Send reply"
                                : "Send reply (demo)"}
                          </Button>
                        </div>
                      </div>
                    </section>
                    <section className="panel details">
                      <h2>Ticket details</h2>
                      <Field label="Assigned to">
                        <Select
                          value={current.owner}
                          disabled={busy}
                          onChange={(e) => {
                            const owner =
                              e.target.value === "Unassigned"
                                ? null
                                : e.target.value;
                            if (live) {
                              act(
                                current.id,
                                () => apiAssign(current.id, owner),
                                owner === null
                                  ? "Ticket unassigned."
                                  : `Assigned to ${owner}. They have been notified.`,
                              );
                              return;
                            }
                            setTickets(
                              tickets.map((t) =>
                                t.id === current.id
                                  ? { ...t, owner: e.target.value }
                                  : t,
                              ),
                            );
                          }}
                        >
                          <option>Unassigned</option>
                          {owners.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Priority">
                        <Select
                          value={current.priority}
                          disabled={busy}
                          onChange={(e) => {
                            const priority = e.target.value;
                            if (live) {
                              act(
                                current.id,
                                () => apiSetPriority(current.id, priority),
                                `Priority set to ${priority}. The response deadline is unchanged - every priority gets the same four working hours.`,
                              );
                              return;
                            }
                            setTickets(
                              tickets.map((t) =>
                                t.id === current.id
                                  ? { ...t, priority: e.target.value }
                                  : t,
                              ),
                            );
                          }}
                        >
                          {["Low", "Normal", "High", "Urgent"].map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </Select>
                      </Field>

                      {/*
                        R19/R28: a Resolved ticket can be closed by hand instead
                        of waiting 72 hours. It still needs a message, and the
                        ticket stays Resolved until the mail server accepts it -
                        so this opens the composer rather than flipping a status.
                      */}
                      {current.status === "Resolved" && (
                        <Button
                          appearance="primary"
                          disabled={busy}
                          onClick={() => {
                            setNote(false);
                            setTarget("Closed");
                            setDraft(
                              draft.trim() === ""
                                ? "We are closing this ticket. Reply to this email if you need anything else and it will reopen."
                                : draft,
                            );
                            setNotice(
                              "Closing needs a message to the employee. Edit it below and send.",
                            );
                          }}
                        >
                          Close this ticket
                        </Button>
                      )}

                      <hr />
                      <small>RESPONSE DEADLINE</small>
                      <p
                        className={
                          current.due.startsWith("Overdue") ? "late" : ""
                        }
                      >
                        {current.due}
                      </p>
                      <small>REQUESTER</small>
                      <p>{current.person}</p>

                      {/*
                        R25. Shown live only: there is no server in sample mode
                        to hold a participant list, and an editable one that
                        forgot on refresh would be a lie about what was saved.
                      */}
                      {live && (
                        <>
                          <hr />
                          <small>ALSO ON THIS TICKET</small>
                          {onTicket.length === 0 ? (
                            <p className="muted">
                              Nobody else is copied. Colleagues CC&rsquo;d by
                              the employee appear here.
                            </p>
                          ) : (
                            <ul className="participants">
                              {onTicket.map((person) => (
                                <li key={person.address}>
                                  <span>{person.address}</span>
                                  <Button
                                    size="small"
                                    appearance="subtle"
                                    icon={<Dismiss12Regular />}
                                    aria-label={`Remove ${person.address}`}
                                    disabled={busy}
                                    onClick={() => {
                                      act(
                                        current.id,
                                        () =>
                                          apiRemoveParticipant(
                                            current.id,
                                            person.address,
                                          ),
                                        `${person.address} removed. They will not receive further replies.`,
                                      );
                                    }}
                                  />
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="add-participant">
                            <Input
                              aria-label="Add a colleague by email"
                              placeholder="name@allcheckservices.com"
                              value={newParticipant}
                              onChange={(_, d) => {
                                setNewParticipant(d.value);
                              }}
                            />
                            <Button
                              disabled={busy || newParticipant.trim() === ""}
                              onClick={() => {
                                const address = newParticipant.trim();
                                setNewParticipant("");
                                act(
                                  current.id,
                                  async () => {
                                    const result = await apiAddParticipants(
                                      current.id,
                                      [address],
                                    );
                                    if (result.added.length === 0) {
                                      // Refused, or already on the ticket. Both
                                      // are worth saying: silently doing
                                      // nothing reads as a broken button.
                                      throw new Error(
                                        result.refused.length > 0
                                          ? `${address} is not an allcheckservices.com address`
                                          : `${address} is already on this ticket`,
                                      );
                                    }
                                  },
                                  `${address} added. They receive future replies, not the history.`,
                                );
                              }}
                            >
                              Add
                            </Button>
                          </div>
                        </>
                      )}

                      {attachments.length > 0 && (
                        <>
                          <hr />
                          <small>ATTACHMENTS</small>
                          <ul className="attachments">
                            {attachments.map((file) => (
                              <li key={file.id}>
                                <Attach20Regular />
                                <a href={attachmentUrl(file.id)}>
                                  {file.filename}
                                </a>
                                <span className="muted">
                                  {Math.max(1, Math.round(file.bytes / 1024))}{" "}
                                  KB
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      {/* R08: who did what, as distinct from what was said. */}
                      {live && audit.length > 0 && (
                        <>
                          <hr />
                          <small>HISTORY</small>
                          <ul className="audit">
                            {audit.map((entry) => (
                              <li key={entry.id}>
                                <strong>{entry.actor}</strong>{" "}
                                {entry.action.replaceAll("_", " ")}
                                {entry.detail === null
                                  ? ""
                                  : ` · ${entry.detail}`}
                                <time>
                                  {entry.at.slice(0, 16).replace("T", " ")}
                                </time>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      <hr />
                      <p className="muted">
                        Working hours
                        <br />
                        Mon–Sat, 9 AM–6 PM IST
                      </p>
                    </section>
                  </div>
                </>
              ) : page === "Reply Templates" ? (
                <>
                  <div className="heading">
                    <div>
                      <h1>Reply templates</h1>
                      <p>Good answers, without starting from scratch.</p>
                    </div>
                    {/*
                      R24: only the admin may change shared templates. All five
                      staff can still select and send them. Hidden rather than
                      disabled because a button that exists and refuses reads as
                      a fault; the server enforces it either way.
                    */}
                    {(!live || identity?.isAdmin === true) && (
                      <Button
                        appearance="primary"
                        icon={<Add20Regular />}
                        onClick={() => {
                          setEditing(templates.length);
                          setName("");
                          setBody("");
                          setTemplateStatus("No change");
                        }}
                      >
                        Create template
                      </Button>
                    )}
                  </div>
                  <div className="templates">
                    {templates.map((t, i) => (
                      <section className="panel template" key={i}>
                        <div className="row">
                          <h2>{t.name}</h2>
                          {(!live || identity?.isAdmin === true) && (
                            <>
                              <Button
                                onClick={() => {
                                  setEditing(i);
                                  setName(t.name);
                                  setBody(t.body);
                                  setTemplateStatus(t.status);
                                }}
                              >
                                Edit
                              </Button>
                              <Button
                                appearance="subtle"
                                icon={<Delete20Regular />}
                                aria-label={`Delete ${t.name}`}
                                disabled={busy}
                                onClick={() => {
                                  saveTemplates(
                                    templates.filter((_, at) => at !== i),
                                    t.id === undefined
                                      ? null
                                      : { deleteId: t.id },
                                  );
                                }}
                              />
                            </>
                          )}
                        </div>
                        <p>{t.body}</p>
                        <small>After sending</small>
                        <div>
                          <Status value={t.status} />
                        </div>
                      </section>
                    ))}
                  </div>
                  {editing >= 0 && (
                    <section className="panel editor">
                      <h2>
                        {editing === templates.length
                          ? "Create reply template"
                          : "Edit reply template"}
                      </h2>
                      <Field label="Template name" required>
                        <Input
                          value={name}
                          onChange={(_, d) => {
                            setName(d.value);
                          }}
                        />
                      </Field>
                      <Field label="Message" required>
                        <Textarea
                          rows={4}
                          value={body}
                          onChange={(_, d) => {
                            setBody(d.value);
                          }}
                        />
                      </Field>
                      <Field label="Status after sending">
                        <Select
                          value={templateStatus}
                          onChange={(e) => {
                            setTemplateStatus(e.target.value);
                          }}
                        >
                          {[
                            "No change",
                            "In Progress",
                            "Waiting for Employee",
                            "Resolved",
                          ].map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </Select>
                      </Field>
                      <div className="row">
                        <Button
                          onClick={() => {
                            setEditing(-1);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          appearance="primary"
                          disabled={busy || !name.trim() || !body.trim()}
                          onClick={() => {
                            const next = [...templates];
                            const existing = templates[editing];
                            next[editing] = {
                              ...(existing?.id === undefined
                                ? {}
                                : { id: existing.id }),
                              name: name.trim(),
                              body: body.trim(),
                              status: templateStatus,
                            };
                            saveTemplates(next, {
                              save: {
                                ...(existing?.id === undefined
                                  ? {}
                                  : { id: existing.id }),
                                name: name.trim(),
                                body: body.trim(),
                                mapsTo:
                                  templateStatus === "No change"
                                    ? null
                                    : templateStatus,
                              },
                            });
                          }}
                        >
                          Save template
                        </Button>
                      </div>
                    </section>
                  )}
                </>
              ) : page === "Team" ? (
                <>
                  <div className="heading">
                    <div>
                      <h1>Your IT team</h1>
                      <p>Shared visibility. Clear ownership.</p>
                    </div>
                    <Badge appearance="tint">
                      {String(
                        live && team.length > 0 ? team.length : staff.length,
                      )}{" "}
                      staff members
                    </Badge>
                  </div>
                  <section className="panel">
                    {(live && team.length > 0
                      ? team
                      : staff.map((s, i) => ({
                          name: s,
                          email: null,
                          available: true,
                          enabled: true,
                          is_admin: i === 0,
                          has_password: false,
                          openTickets: open.filter((t) => t.owner === s).length,
                        }))
                    ).map((member) => (
                      <div className="team-row" key={member.name}>
                        <Avatar name={member.name} />
                        <div>
                          <strong>{member.name}</strong>
                          <small>
                            {member.is_admin ? "Administrator" : "IT support"}
                          </small>
                        </div>
                        <span>{member.openTickets} open tickets</span>
                        {!member.enabled ? (
                          <Badge color="danger" appearance="tint">
                            No account
                          </Badge>
                        ) : (
                          <Badge
                            color={member.available ? "success" : "warning"}
                            appearance="tint"
                          >
                            {member.available ? "Available" : "Unavailable"}
                          </Badge>
                        )}
                        {/*
                          R24 keeps these apart on purpose. Availability stops
                          new work reaching somebody and revokes nothing;
                          disabling the account signs them out and moves their
                          open tickets to whoever can work them.
                        */}
                        {live && identity?.isAdmin === true && (
                          <div className="team-actions">
                            <Button
                              size="small"
                              disabled={busy || !member.enabled}
                              onClick={() => {
                                changeStaff(member.name, {
                                  available: !member.available,
                                });
                              }}
                            >
                              {member.available
                                ? "Mark unavailable"
                                : "Mark available"}
                            </Button>
                            <Button
                              size="small"
                              appearance="subtle"
                              disabled={busy || member.name === identity.name}
                              onClick={() => {
                                changeStaff(member.name, {
                                  enabled: !member.enabled,
                                });
                              }}
                            >
                              {member.enabled
                                ? "Disable account"
                                : "Enable account"}
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </section>
                  <p className="muted">
                    {live
                      ? "Marking somebody unavailable moves their open tickets to whoever can work them, and tells the new owners. Disabling an account also signs them out."
                      : "Sample data. Availability controls appear when a server is connected."}
                  </p>
                </>
              ) : (
                <>
                  <div className="heading">
                    <div>
                      <h1>
                        {page === "My Tickets" ? "My tickets" : "SimpleTickets"}
                      </h1>
                      <p>
                        Your IT support workspace. Every request, clearly owned.
                      </p>
                    </div>
                  </div>
                  <div className="metrics">
                    <div>
                      <div className="metric-top">
                        <span>Open tickets</span>
                        <TicketDiagonal24Regular />
                      </div>
                      <strong>
                        {open.length}
                        <small>Across the team</small>
                      </strong>
                    </div>
                    <div className="attention-metric">
                      <div className="metric-top">
                        <span>Needs attention</span>
                        <Clock24Regular />
                      </div>
                      <strong className="late">
                        {open.filter((t) => t.due.startsWith("Overdue")).length}
                        <small>Overdue response</small>
                      </strong>
                    </div>
                    <div>
                      <div className="metric-top">
                        <span>Waiting for employee</span>
                        <PersonClock24Regular />
                      </div>
                      <strong>
                        {
                          tickets.filter(
                            (t) => t.status === "Waiting for Employee",
                          ).length
                        }
                        <small>Response timer paused</small>
                      </strong>
                    </div>
                    <div>
                      <div className="metric-top">
                        <span>Resolved</span>
                        <ArrowTrendingLines24Regular />
                      </div>
                      <strong>
                        {tickets.filter((t) => t.status === "Resolved").length}
                        <small>Awaiting auto-close</small>
                      </strong>
                    </div>
                  </div>
                  <div className="queue-layout">
                    <section className="panel ticket-panel">
                      <div className="queue-tabs">
                        <button
                          className={!overdueOnly ? "selected" : ""}
                          aria-pressed={!overdueOnly}
                          onClick={() => {
                            setOverdueOnly(false);
                          }}
                        >
                          {page}
                          <span>
                            {
                              tickets.filter(
                                (t) => page !== "My Tickets" || t.owner === me,
                              ).length
                            }
                          </span>
                        </button>
                        <button
                          className={overdueOnly ? "selected" : ""}
                          aria-pressed={overdueOnly}
                          onClick={() => {
                            setOverdueOnly(true);
                          }}
                        >
                          Needs attention
                          <span className="overdue-count">
                            {
                              tickets.filter(
                                (t) =>
                                  t.due.startsWith("Overdue") &&
                                  (page !== "My Tickets" || t.owner === me),
                              ).length
                            }
                          </span>
                        </button>
                      </div>
                      <div className="list-heading">
                        <Input
                          aria-label="Search tickets"
                          contentBefore={<Search20Regular />}
                          placeholder="Search tickets or employees"
                          value={query}
                          onChange={(_, d) => {
                            setQuery(d.value);
                          }}
                        />
                        <Select
                          aria-label="Filter status"
                          value={filter}
                          onChange={(e) => {
                            setFilter(e.target.value);
                          }}
                        >
                          <option>All statuses</option>
                          {statuses.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </Select>
                      </div>
                      <div
                        className="table-scroll"
                        role="region"
                        aria-label="Ticket queue"
                        tabIndex={0}
                      >
                        <Table aria-label="IT tickets">
                          <TableHeader>
                            <TableRow>
                              {[
                                "Ticket",
                                "Status",
                                "Priority",
                                "Assigned to",
                                "Response",
                              ].map((h) => (
                                <TableHeaderCell key={h}>{h}</TableHeaderCell>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {visible.map((t) => (
                              <TableRow
                                key={t.id}
                                className={
                                  t.due.startsWith("Overdue")
                                    ? "overdue-row"
                                    : ""
                                }
                              >
                                <TableCell>
                                  <button
                                    className="ticket-link"
                                    onClick={() => {
                                      setSelected(t.id);
                                      setReplyDraft("");
                                      setNoteDraft("");
                                      setNote(false);
                                      setTarget(
                                        t.status === "New"
                                          ? "In Progress"
                                          : t.status,
                                      );
                                    }}
                                  >
                                    <span className="ticket-id">ST-{t.id}</span>
                                    <strong>{t.title}</strong>
                                    <small>
                                      {t.person}
                                      <span className="email-separator">/</span>
                                      Email request
                                    </small>
                                  </button>
                                </TableCell>
                                <TableCell>
                                  <Status value={t.status} />
                                </TableCell>
                                <TableCell>
                                  <span
                                    className={
                                      "priority " + t.priority.toLowerCase()
                                    }
                                  >
                                    <span
                                      className="priority-bars"
                                      aria-hidden="true"
                                    >
                                      <i />
                                      <i />
                                      <i />
                                    </span>
                                    {t.priority}
                                  </span>
                                </TableCell>
                                <TableCell>
                                  <div className="owner">
                                    <Avatar name={t.owner} size={24} />
                                    {t.owner}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <span
                                    className={
                                      t.due.startsWith("Overdue")
                                        ? "late"
                                        : "muted"
                                    }
                                  >
                                    {t.due}
                                  </span>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {!visible.length && (
                        <div className="empty">
                          <h2>No matching tickets</h2>
                          <p>Try a different search or status.</p>
                          <Button
                            onClick={() => {
                              setQuery("");
                              setFilter("All statuses");
                              setOverdueOnly(false);
                            }}
                          >
                            Clear filters
                          </Button>
                        </div>
                      )}
                      <div className="list-footer">
                        {/* "sample" is not decoration: a dashboard that looks
                            identical connected and disconnected is how someone
                            replies to a ticket they think is a demo. */}
                        Showing {visible.length} {live ? "live" : "sample"}{" "}
                        tickets
                        <span>
                          New requests arrive through your support inbox
                        </span>
                      </div>
                    </section>
                    <div className="queue-rail">
                      <section className="panel workload">
                        <div className="rail-heading">
                          <h2>Team workload</h2>
                          <span>5 available</span>
                        </div>
                        <p>Open tickets by owner</p>
                        {staff.map((s, i) => (
                          <button
                            className="workload-person"
                            key={s}
                            onClick={() => {
                              navigate("Team");
                            }}
                          >
                            <Avatar name={s} size={32} color="neutral" />
                            <span>
                              <strong>{s}</strong>
                              <small>
                                {i === 0 ? "You · Administrator" : "IT support"}
                              </small>
                            </span>
                            <b>{open.filter((t) => t.owner === s).length}</b>
                          </button>
                        ))}
                        <div className="assignment-note">
                          <People24Regular />
                          <p>
                            Assigned by workload.
                            <br />
                            <span>Balanced across available staff.</span>
                          </p>
                        </div>
                      </section>
                    </div>
                  </div>
                  <div className="bottom-note">
                    <Mail24Regular />
                    <span>support@allcheckservices.com</span>
                    <span>
                      Mail connection will be configured after the prototype
                      review.
                    </span>
                  </div>
                </>
              )}
            </main>
            <footer>
              SimpleTickets <span>Built for your internal IT team</span>
            </footer>
          </div>
        </div>
      )}
    </FluentProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(<App />);
