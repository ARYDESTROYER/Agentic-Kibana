---
id: mail_abuse
title: Suspicious mail activity (Postfix)
applies_to_rules: [postfix]
applies_to_techniques: [T1566]
applies_to_entities: [ip]
keywords: [postfix, smtp, relay, recipient, spam, mail]
persona: identity_access
summary: High-volume relay attempts, rejected recipients, or submission auth failures.
---
## What this looks like
Postfix logs showing high-volume relay attempts, repeated rejected recipients, or
authentication failures on the submission port — spam-relay abuse or credential
stuffing against mail.

## Steps
1. **Classify the pattern.** Outbound relay attempts vs inbound spam vs auth
   failures on submission each mean different things.
2. **Check for auth success** on the submission service (mirrors the brute-force
   runbook) — a successful auth followed by sending is account abuse.
3. **Sender/recipient reputation.** Look at rejection reasons (RBL hits, unknown
   recipients) and sender domains.
4. **Volume + ratio.** A few rejects are normal mail hygiene; sustained high-volume
   relay attempts are abuse.

## Verdict guidance
- Authenticated then mass-sending → TRUE_POSITIVE, escalate (compromised mailbox).
- High-volume relay/spam from a hostile IP → TRUE_POSITIVE (block).
- Low-volume rejects / normal bounce traffic → FALSE_POSITIVE.
