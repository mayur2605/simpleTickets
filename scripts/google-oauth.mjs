// One-off: exchange a Google OAuth desktop client for a refresh token.
//
// Runs a loopback server, opens Google's consent screen, catches the
// authorisation code and swaps it for tokens. Uses PKCE and a state check, so
// an authorisation code intercepted on the loopback interface is useless on
// its own.
//
// The client secret is read from a hidden prompt, never an argument. The
// refresh token is printed once, for you to paste into a Worker secret. It is
// not written to disk.
//
// Usage:  node scripts/google-oauth.mjs
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { emitKeypressEvents } from "node:readline";
import { spawn } from "node:child_process";

// Least privilege: read messages and send replies. Deliberately NOT
// gmail.modify - the ticket database tracks which messages are processed, so
// the app never needs to alter the mailbox.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

function prompt(label, hidden) {
  if (!process.stdin.isTTY) throw new Error("Run this in an interactive terminal.");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    emitKeypressEvents(process.stdin);
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
    };
    function onKey(text, key = {}) {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        done(); reject(new Error("Cancelled.")); return;
      }
      if (key.name === "return" || key.name === "enter") {
        done(); resolve(value.trim()); return;
      }
      if (key.name === "backspace") {
        value = [...value].slice(0, -1).join("");
        if (!hidden) process.stdout.write("\b \b");
        return;
      }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) {
        value += text;
        process.stdout.write(hidden ? "*" : text);
      }
    }
    process.stdin.on("keypress", onKey);
  });
}

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("Google OAuth setup for SimpleTickets");
console.log(`Scopes: ${SCOPES}\n`);

const clientId = await prompt("Client ID: ", false);
const clientSecret = await prompt("Client secret (hidden): ", true);
if (!clientId || !clientSecret) {
  console.error("Both values are required.");
  process.exit(1);
}

const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash("sha256").update(verifier).digest());
const state = base64url(randomBytes(16));

const server = createServer();
await new Promise((r) => { server.listen(0, "127.0.0.1", r); });
const { port } = server.address();
const redirectUri = `http://127.0.0.1:${port}`;

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",        // required to receive a refresh token
    prompt: "consent",             // force a refresh token even on re-auth
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

console.log("\nApprove access in the browser window that opens.");
console.log("If it does not open, paste this URL yourself:\n");
console.log(authUrl + "\n");
spawn("open", [authUrl], { stdio: "ignore", detached: true }).unref();

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error("Timed out after 5 minutes.")); }, 300000);
  server.on("request", (req, res) => {
    const url = new URL(req.url, redirectUri);
    const returned = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const ok = url.searchParams.get("state") === state;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      error ? `Authorisation failed: ${error}. Return to the terminal.`
      : !ok ? "State mismatch; nothing was authorised. Return to the terminal."
      : "Authorised. You can close this tab and return to the terminal.",
    );
    clearTimeout(timer);
    if (error) reject(new Error(`Google returned: ${error}`));
    else if (!ok) reject(new Error("State mismatch - possible interference. Nothing stored."));
    else resolve(returned);
  });
});
server.close();

const response = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }),
});
const tokens = await response.json();

if (!response.ok || !tokens.refresh_token) {
  console.error(`\nFAILED ${response.status}: ${JSON.stringify(tokens)}`);
  console.error(
    "\nNo refresh token usually means this account has authorised the app before.",
  );
  console.error(
    "Remove it at https://myaccount.google.com/permissions and run this again.",
  );
  process.exit(1);
}

console.log("\n--- REFRESH TOKEN (shown once, not saved) ---\n");
console.log(tokens.refresh_token);
console.log("\n--- end ---");
console.log(`\nGranted scopes: ${tokens.scope ?? "(none reported)"}`);
console.log("Store it, along with the client id and secret, as Worker secrets.");
console.log("Do not paste it into chat or commit it.");
