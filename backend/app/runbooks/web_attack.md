---
id: web_attack
title: Web application attack (WAF / ModSecurity)
applies_to_rules: [modsecurity, modsec_audit_log, nginx, apache]
applies_to_techniques: [T1190]
applies_to_entities: [ip]
keywords: [modsec, waf, sqli, xss, lfi, rfi, traversal, owasp, http, web, "941"]
persona: web_application
summary: A WAF/ModSec rule fired on a request to a public-facing web app.
---
## What this looks like
ModSecurity / WAF rules triggering (SQLi, XSS, path traversal, LFI/RFI) against a
public web app, usually from one client IP across several endpoints.

## Steps
1. **Read the response code.** A `403`/blocked status means the WAF held; a `200`
   (or `500` from a backend error) on a rule-flagged request means the payload may
   have reached the application — treat that as far more serious.
2. **Inspect the payload.** Is it a generic scanner signature or a crafted,
   target-specific exploit? Decode the request URI/body.
3. **Correlate by client IP** across endpoints and time. A single IP hitting many
   distinct attack paths is either a scanner or a determined attacker; breadth +
   any `200` distinguishes them.
4. **Look for success signals.** Unusual response sizes, new files, error stacks,
   or follow-on requests to admin/upload endpoints.

## Verdict guidance
- Flagged request returned `200` with a crafted payload → TRUE_POSITIVE, escalate.
- All flagged requests blocked (`403`) → likely FALSE_POSITIVE / contained recon.
- Can't tell if the app processed it → NEEDS_HUMAN.
