/**
 * Seed the staff table, and set the first password.
 *
 * The password half exists to break a deliberate deadlock. Only an admin
 * *session* may provision a password (R06: no self-registration), and a fresh
 * database has no account with one — so nobody can sign in to grant the first
 * one. The safe direction is to leave it that way in the API and bootstrap from
 * the machine instead: whoever can run this already has the database, so it
 * grants no access they did not have, and the API keeps no back door.
 *
 *   npm run db:seed                  — create staff1..staff5, staff1 as admin
 *   npm run db:seed -- --password staff1   — set a password, prompted, not echoed
 *
 * The password is read from the terminal, never from argv: arguments end up in
 * shell history and in `ps`.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createPool } from "./pool.ts";
import { config } from "../config.ts";
import { addStaff, setPasswordHash, staffWorkloads, upsertTemplate } from "../store.ts";
import { hashPassword } from "../password.ts";

/** R07: five IT staff. staff1 is the admin, as chosen. */
export const STAFF = ["staff1", "staff2", "staff3", "staff4", "staff5"] as const;
export const ADMIN = "staff1";
const MIN_PASSWORD_LENGTH = 12;

/**
 * The four starter templates R24 names, with the status each one requests.
 *
 * Wording matters more here than anywhere else in the codebase: these go to
 * real employees under five different people's names, so they say what happens
 * next and when, and none of them tells the employee to close anything by
 * replying — R24 and the constitution both forbid that, and an employee who
 * follows such an instruction gets a reopened ticket instead.
 *
 * "Troubleshooting steps" is deliberately incomplete. The steps are
 * issue-specific and belong to whoever is sending it; shipping plausible
 * generic ones would get them sent unedited.
 */
export const STARTER_TEMPLATES = [
  {
    name: "Working on it",
    mapsTo: "In Progress",
    body: [
      "Thanks for getting in touch. We have picked this up and are looking at it now.",
      "",
      "We will come back to you as soon as we know more. If anything changes at your",
      "end in the meantime, reply to this email and it will be added to the ticket.",
    ].join("\n"),
  },
  {
    name: "Request more details",
    mapsTo: "Waiting for Employee",
    body: [
      "Thanks for getting in touch. Before we can go further we need a little more",
      "detail:",
      "",
      "  - What exactly did you see, and what did you expect to see instead?",
      "  - When did it start, and does it happen every time?",
      "  - Which device and which application?",
      "",
      "A screenshot helps if you can attach one. Reply to this email and it will be",
      "added to the ticket.",
    ].join("\n"),
  },
  {
    name: "Troubleshooting steps",
    mapsTo: "Waiting for Employee",
    body: [
      "Thanks for waiting. Please try the following and let us know what happens:",
      "",
      "  1. [replace with the first step before sending]",
      "  2. [replace with the second step before sending]",
      "",
      "Reply to this email with what you saw at each step, including any error",
      "message, and it will be added to the ticket.",
    ].join("\n"),
  },
  {
    name: "Issue resolved",
    mapsTo: "Resolved",
    body: [
      "This should now be sorted. Please have a look and confirm it is working for",
      "you.",
      "",
      "If it is not, reply to this email and the ticket reopens - you do not need to",
      "start a new request.",
    ].join("\n"),
  },
] as const;

async function promptSecret(question: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const rl = createInterface({ input, output, terminal: true });
  return new Promise<string>((res) => {
    // Suppress echo: the callback is what readline writes with, so returning
    // nothing for the typed characters keeps the password off the screen.
    const muted = Object.defineProperty(rl, "_writeToOutput", {
      value: (text: string) => {
        if (text.includes(question)) output.write(text);
      },
      configurable: true,
    });
    muted.question(question, (answer) => {
      output.write("\n");
      rl.close();
      res(answer);
    });
  });
}

export async function seedStaff(connectionString: string): Promise<string[]> {
  const pool = createPool(connectionString);
  try {
    for (const name of STAFF) {
      await addStaff(pool, name, `${name}@allcheckservices.com`, name === ADMIN);
    }
    // Name-keyed upsert, so re-seeding refreshes the starter wording without
    // duplicating it - and without touching anything the admin has added.
    for (const template of STARTER_TEMPLATES) {
      await upsertTemplate(pool, {
        name: template.name,
        body: template.body,
        mapsTo: template.mapsTo,
      });
    }
    return (await staffWorkloads(pool)).map((member) => member.name);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const flagIndex = process.argv.indexOf("--password");
  if (flagIndex === -1) {
    const names = await seedStaff(config.databaseUrl);
    console.log(`staff: ${names.join(", ")} (admin: ${ADMIN})`);
    console.log(`Set the first password with:  npm run db:seed -- --password ${ADMIN}`);
    return;
  }

  const name = process.argv[flagIndex + 1];
  if (name === undefined) throw new Error("Usage: npm run db:seed -- --password <name>");

  const password = await promptSecret(`New password for ${name}: `);
  if (password.length < MIN_PASSWORD_LENGTH) {
    // Matches the API's rule, so a password set here cannot be weaker than one
    // set through the dashboard.
    throw new Error(`Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
  }
  const again = await promptSecret("Repeat it: ");
  if (again !== password) throw new Error("Passwords did not match.");

  const pool = createPool(config.databaseUrl);
  try {
    const changed = await setPasswordHash(pool, name, await hashPassword(password));
    if (!changed) throw new Error(`No staff member named ${name}. Run the seed first.`);
    console.log(`Password set for ${name}.`);
  } finally {
    await pool.end();
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.filename === resolve(invoked)) {
  await main();
}
