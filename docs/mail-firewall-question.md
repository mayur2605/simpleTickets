# Question for the mail host administrator

Status: draft, not sent. Send this to whoever administers `mail.allcheckservices.com`.
Their answer decides the hosting architecture — see `docs/stack-validation.md`.

Edit the last line to name who should reply and by when, then send.

---

**Subject:** IMAP/SMTP to mail.allcheckservices.com times out from outside our network

Hello,

We are building an internal IT ticketing system that reads and sends mail for
`support@allcheckservices.com`. It needs to connect to `mail.allcheckservices.com`
over IMAP and SMTP from a server outside our office network.

Those connections time out. The same connections succeed from inside our office.

**What we tested, on 16 September 2026:**

| Source | Target | Result |
| --- | --- | --- |
| Our office machine | mail.allcheckservices.com:993 | TLS 1.2 handshake succeeded |
| Our office machine | mail.allcheckservices.com:465 | TLS 1.3 handshake succeeded |
| Our office machine | mail.allcheckservices.com:587 | Connected, Postfix greeting received |
| Cloud server | mail.allcheckservices.com:993, :465, :587 | No response, timed out after 8 seconds |
| Cloud server | 49.50.108.191:993 (same host, by IP) | No response, timed out after 8 seconds |
| Cloud server | imap.gmail.com:993 | Connected in 68 ms |
| Cloud server | smtp.gmail.com:465 | Connected in 183 ms |

The last two lines are a control: the cloud server can open IMAP and SMTP connections
to other mail providers on the same ports, so its outbound traffic is not blocked in
general, and the ports are not blocked on its side.

The connections **time out rather than being refused**. A closed port normally refuses
immediately. A timeout means the packets are being dropped, which usually indicates a
firewall rule rather than a service that is down or a port that is closed.

**Our questions:**

1. Is there a firewall or security policy on `mail.allcheckservices.com` that restricts
   IMAP and SMTP to specific IP addresses or ranges, or that blocks connections from
   datacenter and cloud hosting providers?
2. If there is, can it be relaxed for a single static IP address that we would provide
   to you in advance?
3. If it cannot be relaxed, is there a supported way for an internal application to
   reach the mailbox from outside the office?

**What we are not asking for:**

We are not requesting any change to mail routing, MX records, or mailbox configuration,
and we are not asking for credentials in this message. We have not attempted to log in
from the cloud server — only to open a connection, which never completed.

You can reproduce this from any machine outside our office network:

```
openssl s_client -connect mail.allcheckservices.com:993 -servername mail.allcheckservices.com
```

Inside the office this returns a certificate and an IMAP greeting. Outside, it hangs.

Please let us know either way, as it determines how we build this system.

Thanks,
[your name]
