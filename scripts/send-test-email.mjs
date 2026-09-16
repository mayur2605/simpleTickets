// Sends ONE test email through Resend to a recipient named on the command line.
// No dependencies: Node's built-in fetch only.
//
// The recipient is a required argument rather than a default, so this cannot
// send to anyone by accident. The API key is read from a hidden prompt and is
// never placed in a command argument, an environment file, or the logs.
//
// Usage:
//   node scripts/send-test-email.mjs someone@allcheckservices.com
import { emitKeypressEvents } from "node:readline";

const FROM = "SimpleTickets Support <support@tickets.allcheckservices.com>";

const to = process.argv[2];
if (!to || !to.includes("@")) {
  console.error("Usage: node scripts/send-test-email.mjs <recipient-address>");
  console.error("The recipient must be named explicitly. There is no default.");
  process.exit(1);
}

function hiddenPrompt(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this directly in an interactive terminal.");
  }
  return new Promise((resolve, reject) => {
    let secret = "";
    const wasRaw = process.stdin.isRaw;
    emitKeypressEvents(process.stdin);
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function cleanup() {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
    }
    function onKey(text, key = {}) {
      if (key.ctrl && (key.name === "c" || key.name === "d")) {
        cleanup();
        secret = "";
        reject(new Error("Cancelled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        const value = secret;
        secret = "";
        resolve(value);
        return;
      }
      if (key.name === "backspace") {
        secret = [...secret].slice(0, -1).join("");
        return;
      }
      if (key.ctrl && key.name === "u") {
        secret = "";
        return;
      }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) secret += text;
    }
    process.stdin.on("keypress", onKey);
  });
}

console.log("SimpleTickets send test");
console.log(`From: ${FROM}`);
console.log(`To:   ${to}`);
console.log("One message will be sent. Ctrl+C now to abort.\n");

let apiKey;
try {
  apiKey = await hiddenPrompt("Resend API key (hidden, not saved): ");
  if (!apiKey) throw new Error("No key entered; nothing was sent.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const stamp = new Date().toISOString();
let response;
try {
  response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: `SimpleTickets send test ${stamp}`,
      text:
        "This is an automated test from the SimpleTickets project.\n\n" +
        "It checks that outgoing mail leaves Resend, arrives, and shows the " +
        "correct sender. Nothing else was sent and no ticket was created.\n\n" +
        `Sent at ${stamp}.\n`,
    }),
  });
} catch (error) {
  console.error(`Request failed: ${error.message}`);
  process.exit(1);
}

apiKey = "";
const body = await response.json().catch(() => ({}));

if (!response.ok) {
  // Resend error bodies describe the problem and carry no credential.
  console.error(`FAIL ${response.status}: ${JSON.stringify(body)}`);
  process.exit(1);
}

console.log(`PASS: accepted by Resend. Message id: ${body.id ?? "(none returned)"}`);
console.log("Acceptance is not delivery. Confirm it actually arrives in the inbox,");
console.log("and check the sender shows as the support address.");
