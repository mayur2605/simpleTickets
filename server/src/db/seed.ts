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
import { addStaff, setPasswordHash, staffWorkloads } from "../store.ts";
import { hashPassword } from "../password.ts";

/** R07: five IT staff. staff1 is the admin, as chosen. */
export const STAFF = ["staff1", "staff2", "staff3", "staff4", "staff5"] as const;
export const ADMIN = "staff1";
const MIN_PASSWORD_LENGTH = 12;

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
