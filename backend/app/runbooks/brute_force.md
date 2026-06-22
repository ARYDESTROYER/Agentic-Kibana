---
id: brute_force
title: SSH / credential brute force
applies_to_rules: [sshd, linux_auth, postfix, winlogon]
applies_to_techniques: [T1110, T1078]
applies_to_entities: [ip, user]
keywords: [ssh, brute, failed password, auth, login, credential, 4625]
persona: identity_access
summary: A burst of failed authentications from one source against a host or user.
---
## What this looks like
A spike of failed authentications (sshd "Failed password", repeated auth failures,
Windows 4625) from one source IP, or against one account from many sources
(password spray).

## Steps
1. **Did anything succeed?** This is the pivotal question. Query for a successful
   login (sshd "Accepted password/publickey", 4624) from the same source/account in
   and just after the window. A success turns this from noise into a likely
   compromise (T1078 Valid Accounts).
2. **Scope the usernames.** Count distinct targeted usernames. Many users = spray;
   one user, many tries = targeted guessing; a couple of failures then success =
   probably a fat-finger, not an attack.
3. **Scope the sources.** One IP vs many. Enrich the source IP reputation.
4. **Look for follow-on.** If a login succeeded, look for lateral movement, new
   sessions, privilege use from that account.

## Verdict guidance
- Sustained burst, no success, hostile IP → TRUE_POSITIVE (recommend block).
- Success after a burst → TRUE_POSITIVE, escalate (possible account compromise).
- A few failures then a normal success from a known user/host → FALSE_POSITIVE.
- Ambiguous (can't confirm success, partial evidence) → NEEDS_HUMAN.
