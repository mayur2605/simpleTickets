import { emitKeypressEvents } from 'node:readline';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

function passwordPrompt() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this command directly in an interactive terminal.');
  return new Promise((resolve, reject) => {
    let secret = '';
    const wasRaw = process.stdin.isRaw;
    emitKeypressEvents(process.stdin);
    process.stdout.write('Mailbox password (hidden; not saved): ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function cleanup() {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
    }
    function onKey(text, key = {}) {
      if ((key.ctrl && key.name === 'c') || (key.ctrl && key.name === 'd')) { cleanup(); secret = ''; reject(new Error('Cancelled.')); return; }
      if (key.name === 'return' || key.name === 'enter') { cleanup(); const value = secret; secret = ''; resolve(value); return; }
      if (key.name === 'backspace') { secret = [...secret].slice(0, -1).join(''); return; }
      if (key.ctrl && key.name === 'u') { secret = ''; return; }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) secret += text;
    }
    process.stdin.on('keypress', onKey);
  });
}

function failure(label, error) {
  // Never log raw protocol errors: they may contain authentication command data.
  const safeCodes = new Set(['EAUTH', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ESOCKET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  const reason = safeCodes.has(error?.code) ? error.code : 'Login or connection failed';
  console.log(`${label}: FAIL (${reason}). No automatic retry.`);
  process.exitCode = 1;
}

console.log('SimpleTickets mail login check');
console.log('Account: support@allcheckservices.com');
console.log('Server: mail.allcheckservices.com');
console.log('No messages will be read, changed, deleted, or sent.');
let pass;
try {
  pass = await passwordPrompt();
  if (!pass) throw new Error('Empty password; no connection attempted.');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const host = 'mail.allcheckservices.com';
const auth = {user: 'support@allcheckservices.com', pass};
const imap = new ImapFlow({host, port: 993, secure: true, auth, logger: false, disableAutoIdle: true,
  tls: {rejectUnauthorized: true, servername: host}, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000});
// The error event is consumed without printing potentially sensitive details.
imap.on('error', () => {});
let imapOK = false;
try {
  await imap.connect();
  imapOK = true;
  console.log('IMAP 993: PASS (authenticated; no mailbox opened).');
  try { await imap.logout(); } catch { imap.close(); }
} catch (error) { failure('IMAP 993', error); }
finally { imap.close(); }
// Avoid a second password attempt if IMAP failed (protects against account lockout).
if (imapOK) {
  const smtp = nodemailer.createTransport({host, port: 465, secure: true, auth,
    tls: {rejectUnauthorized: true, servername: host}, logger: false, debug: false,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000});
  try {
    await smtp.verify();
    console.log('SMTP 465: PASS (authenticated; no email sent).');
  } catch (error) { failure('SMTP 465', error); }
  finally { smtp.close(); }
} else console.log('SMTP: skipped after IMAP failure.');
auth.pass = ''; pass = '';
console.log('Check complete. This does not prove Cloudflare connectivity or message delivery.');
