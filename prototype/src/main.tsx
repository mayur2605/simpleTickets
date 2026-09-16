import { useState } from "react";
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
} from "@fluentui/react-components";
import {
  TicketDiagonal24Regular,
  Search20Regular,
  People24Regular,
  TextBulletListSquare24Regular,
  Mail24Regular,
  ArrowLeft20Regular,
  Add20Regular,
  CheckmarkCircle20Regular,
  Clock24Regular,
  ArrowTrendingLines24Regular,
  PersonClock24Regular,
} from "@fluentui/react-icons";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "./style.css";
import "./brand.css";
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
const initialTemplates = [
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
function App() {
  const [tickets, setTickets] = useState(seed),
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
      Record<number, { text: string; note: boolean }[]>
    >({}),
    [editing, setEditing] = useState(-1),
    [name, setName] = useState(""),
    [body, setBody] = useState(""),
    [templateStatus, setTemplateStatus] = useState("No change");
  const draft = note ? noteDraft : replyDraft;
  const setDraft = note ? setNoteDraft : setReplyDraft;
  const current = tickets.find((t) => t.id === selected);
  const open = tickets.filter(
    (t) => !["Resolved", "Closed"].includes(t.status),
  );
  const visible = tickets.filter(
    (t) =>
      (!overdueOnly || t.due.startsWith("Overdue")) &&
      (page !== "My Tickets" || t.owner === staff[0]) &&
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
    setMessages({
      ...messages,
      [current.id]: [...(messages[current.id] || []), { text: draft, note }],
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
            <Avatar name={staff[0]} size={32} />
            <div>
              <strong>{staff[0]}</strong>
              <small>IT administrator · Demo</small>
            </div>
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
            <div className="preview">
              Sample data only. Changes last until you refresh. No emails are
              sent.
            </div>
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
                      <article key={i} className={m.note ? "internal" : ""}>
                        <strong>
                          {staff[0]} ·{" "}
                          {m.note ? "Internal note" : "Public reply"}
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
                            defaultValue=""
                            onChange={(e) => {
                              const t = templates[Number(e.target.value)];
                              if (t) {
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
                          <Field label="Status after sending">
                            <Select
                              value={target}
                              onChange={(e) => {
                                setTarget(e.target.value);
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
                            !draft.trim() || draft.includes("[Add steps")
                          }
                          onClick={send}
                        >
                          {note ? "Add internal note" : "Send reply (demo)"}
                        </Button>
                      </div>
                    </div>
                  </section>
                  <section className="panel details">
                    <h2>Ticket details</h2>
                    <Field label="Assigned to">
                      <Select
                        value={current.owner}
                        onChange={(e) => {
                          setTickets(
                            tickets.map((t) =>
                              t.id === current.id
                                ? { ...t, owner: e.target.value }
                                : t,
                            ),
                          );
                        }}
                      >
                        {staff.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Priority">
                      <Select
                        value={current.priority}
                        onChange={(e) => {
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
                </div>
                <div className="templates">
                  {templates.map((t, i) => (
                    <section className="panel template" key={i}>
                      <div className="row">
                        <h2>{t.name}</h2>
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
                        disabled={!name.trim() || !body.trim()}
                        onClick={() => {
                          const next = [...templates];
                          next[editing] = {
                            name: name.trim(),
                            body: body.trim(),
                            status: templateStatus,
                          };
                          setTemplates(next);
                          setEditing(-1);
                          setNotice("Template saved for this preview.");
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
                  <Badge appearance="tint">5 staff members</Badge>
                </div>
                <section className="panel">
                  {staff.map((s, i) => (
                    <div className="team-row" key={s}>
                      <Avatar name={s} />
                      <div>
                        <strong>{s}</strong>
                        <small>
                          {i === 0 ? "Administrator" : "IT support"}
                        </small>
                      </div>
                      <span>
                        {open.filter((t) => t.owner === s).length} open tickets
                      </span>
                      <Badge color="success" appearance="tint">
                        Available
                      </Badge>
                    </div>
                  ))}
                </section>
                <p className="muted">
                  Availability controls will be added with the assignment
                  engine. This page previews team workload.
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
                              (t) =>
                                page !== "My Tickets" || t.owner === staff[0],
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
                                (page !== "My Tickets" || t.owner === staff[0]),
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
                                t.due.startsWith("Overdue") ? "overdue-row" : ""
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
                      Showing {visible.length} sample tickets
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
    </FluentProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(<App />);
