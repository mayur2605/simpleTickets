# Local mail authentication check

Run from an interactive terminal:

```sh
node /Users/mayurkulkarni/Downloads/simpleTickets/tools/mail-check/check.mjs
```

Enter the mailbox's normal password at the hidden prompt, not in chat or as a command argument. The password is held only in process memory and is not intentionally stored or logged. JavaScript does not guarantee zeroization of memory copies. Ctrl+C cancels; Backspace edits; Ctrl+U clears input.

The script verifies TLS and authenticates to IMAP 993, logs out without opening a mailbox, then uses Nodemailer's SMTP `verify()` on port 465. It does not call a message-fetch or send method. SMTP is skipped if IMAP fails to avoid another attempt with a potentially incorrect password. No automatic retries. Server-side login auditing may record the authentication attempt.

Share only the PASS/FAIL summary. Mail delivery, sender authorization, polling and Cloudflare runtime behavior remain separate tests.
