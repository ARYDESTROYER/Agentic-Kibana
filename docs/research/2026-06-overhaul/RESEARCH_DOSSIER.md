# RESEARCH_DOSSIER — External + Standards Research (2026-06 overhaul)

> Consolidated external research underpinning the feature designs. Each section
> lists the load-bearing findings + concrete specs we adopt, with sources.

---

## 1. Reference architecture: Agentic SOC Platform (FunnyWolf/asp.viperrtp.com)

The closest open-source peer (MIT, on-prem, Python+TS, Splunk/ELK, MCP). What we
borrow vs. where we diverge.

**Borrow:**
- **Three-entity model** Case / Alert / Artifact — but we keep our Case/Cluster/
  RawEvent spine; "Artifact" maps to our entities + IOC enrichment.
- **Disposition separate from status** — ASP has 5 statuses + 12 verdicts. We
  split status (lifecycle) from disposition (verdict outcome). See STATUS_TAXONOMY.
- **Readable IDs** — `case_000001` (6-digit zero-padded, separate sequence per
  entity type). Confirms F7's sequence-counter approach.
- **Playbooks as first-class** (one-click investigate / extract-knowledge /
  enrich) and **knowledge extraction on close** → F10 + F11.
- **RBAC tiers** Tier1/Tier2/Tier3 + Manager + Admin, module-level perms → F2.
- **103+ enrichment providers, 24 enrichment types** — informs F11 threat-context
  provider abstraction.

**Diverge:** ASP lets AI write `severity_ai/verdict_ai` but humans decide close.
We go further: **close/escalate is deterministic code (#3)**, never analyst-free
and never LLM-set. ASP's auto-close-at-98%-agreement is exactly our AutoClosePolicy.

ASP concrete enums adopted-as-reference:
- Status: New, In Progress, On Hold, Resolved, Closed
- Verdict: Unknown, False Positive, True Positive, Suspicious, Benign,
  Insufficient Data, Duplicate, Security Risk, Managed Externally, Other
- Confidence: Unknown, Low, Medium, High
- Playbook job status: PENDING, RUNNING, SUCCESS, FAILED

Sources: https://github.com/FunnyWolf/agentic-soc-platform · https://asp.viperrtp.com/

---

## 2. Status taxonomy standards (NIST / SANS / Sentinel / Splunk / Chronicle / TheHive)

**Core finding (cross-vendor consensus):** STATUS (operational lifecycle) and
DISPOSITION/CLASSIFICATION (investigative verdict) are SEPARATE fields. Conflating
them causes status bloat and prevents independent tracking. "Needs human" is NOT a
status — it is `assigned_to IS NULL` or an `escalation_level > 0` flag.

- **NIST SP 800-61r3 (Apr 2025)**: dropped the rigid 4-phase model for CSF 2.0
  functions (Govern/Identify/Protect/Detect/Respond/Recover). Map status *progress*
  to functions, don't use functions as status values.
- **Microsoft Sentinel**: Status = {New, Active, Closed}; Classification (mandatory
  on close) = {True Positive, Benign Positive, False Positive — Incorrect Alert
  Logic, False Positive — Incorrect Data, Undetermined}.
- **Splunk Mission Control**: Status {New, Pending, Closed} + Disposition {True
  Positive, Benign Positive, False Positive — Incorrect Logic, False Positive —
  Inaccurate Data, Undetermined}.
- **TheHive 5**: hard 4-stage model (New, Imported, In Progress, Closed) with
  customizable statuses per stage; **no backward stage transitions without admin**.
- **Splunk SOAR**: 3 base status types (New/Open/Closed) + up to 10 custom.
- **Separate escalation/assignment fields** (ITIL/ServiceNow): `escalation_level`,
  `escalated_to`, `escalation_reason`, `assigned_to`, `assigned_at`. Never status.

**Adopted shape** (see STATUS_TAXONOMY.md for the full table + migration):
- Status enum: NEW, OPEN, INVESTIGATING, ESCALATED, ON_HOLD, RESOLVED, CLOSED
- Disposition enum: TRUE_POSITIVE, FALSE_POSITIVE_LOGIC, FALSE_POSITIVE_DATA,
  BENIGN_POSITIVE, DUPLICATE, UNDETERMINED

Sources: https://csrc.nist.gov/pubs/sp/800/61/r3/final ·
https://learn.microsoft.com/en-us/azure/sentinel/incident-navigate-triage ·
https://help.splunk.com/.../configure-dispositions-for-findings ·
https://docs.strangebee.com/thehive/administration/status/about-statuses/

---

## 3. RBAC for SOC platforms

**Finding:** vendors converge on 4–6 roles in a tiered analyst model. FastAPI
pattern = dependency injection (`require_role(roles)`) extracting role from JWT;
React pattern = `ProtectedRoute`/`<Can>` checking `user.role`, **server enforces
on every request** (client guards are UX only). Audit every state change.

Vendor role sets: Sentinel (Reader/Responder/Contributor/Playbook Operator);
Splunk ES (ess_user/ess_analyst/ess_admin); Chronicle (Administrator/Editor/Viewer
+ Data RBAC); TheHive (Admin/Org/External + composable permission functions);
Security Onion (Superuser/Analyst/Limited-Analyst/Auditor).

**Adopted role set:** `super_admin, soc_manager, analyst_tier2, analyst_tier1,
responder, auditor`. Permission matrix over resources (cases, sources, settings,
users, playbooks, rag, cost, audit) with verbs (read/write/close/run/approve/
manage). Default-deny on state-changing routes; CI test enforces coverage.

Concrete: access token TTL 15min for SOC platforms; audit schema
`(timestamp, user_id, role, action, resource, old_value, new_value, status,
deny_reason, client_ip)`, immutable, 7yr retention. OWASP: enforce least privilege,
deny-by-default, validate server-side, comprehensive parseable audit log.

Sources: https://learn.microsoft.com/en-us/azure/sentinel/roles ·
https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html ·
https://csrc.nist.gov/projects/role-based-access-control ·
https://docs.securityonion.net/en/2.4/rbac.html

---

## 4. TOTP / MFA (RFC 6238) — stdlib, browser-rendered QR

**Finding:** TOTP is pure-stdlib (`hmac`, `hashlib`, `struct`, `base64`, `time`).
No `pyotp`/`qrcode` backend dep needed. QR is generated **client-side** (e.g.
`qr-creator`, ~4.75kB gzip) from the `otpauth://` URI — no server image lib.

Concrete:
- URI: `otpauth://totp/Issuer:account?secret=BASE32&issuer=Issuer&algorithm=SHA1&digits=6&period=30`
  (Base32 secret, no padding; percent-encode issuer/label).
- Secret: `secrets.token_bytes(20)` → `base64.b32encode()` (160 bits, 32 chars).
- HOTP: `T = floor(now/30)`; `HMAC = hmac.new(b32decode(secret), pack('>Q',T), sha1)`;
  `offset = HMAC[-1] & 0x0f`; `code = (unpack('>I', HMAC[offset:offset+4])[0] &
  0x7fffffff) % 1000000`; zero-pad to 6.
- Verify window: accept T-1, T, T+1 (±60s drift). Reject reuse within same step
  (replay protection via stored `last_time_step`).
- Recovery codes: 10–12 of 8 hex chars (`secrets.token_bytes(4).hex().upper()`),
  bcrypt/PBKDF2-hashed, single-use (`used_at`).
- Secret encryption at rest: AES via `cryptography.Fernet` with a key from Secrets;
  if `cryptography` unavailable, store under the secret tier with the same
  in-memory-only discipline as `connector_secrets`.

Sources: https://datatracker.ietf.org/doc/html/rfc6238 ·
https://github.com/google/google-authenticator/wiki/Key-Uri-Format ·
https://github.com/nimiq/qr-creator

---

## 5. OIDC SSO (Google + Microsoft Entra + generic)

**Finding:** Authorization Code + PKCE (S256), server-side code exchange, validate
the `id_token` JWS signature against the provider JWKS (RS256) — never trust a
frontend-supplied token. `PyJWT[crypto] >= 2.13.0` (`PyJWKClient` auto-fetches +
caches JWKS). Discovery via `.well-known/openid-configuration`.

Concrete endpoints/claims:
- Google discovery `https://accounts.google.com/.well-known/openid-configuration`;
  claims: `sub` (stable), `email`, `email_verified`, `hd` (Workspace domain),
  `nonce`, `iss`, `aud`. Domain restriction via the `hd` parameter + claim check.
- Microsoft discovery `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`
  (tenant = common/organizations/consumers/{guid}); claims: `oid` (immutable per
  user/tenant), `tid` (tenant), `sub` (pairwise), `email`, `preferred_username`.
  Tenant restriction via `tid` allowlist.
- Scopes: minimum `openid email`; add `profile` for name/picture.
- State + nonce: random, server-side (short-lived KV), single-use (CSRF/replay).

Validation checklist: kid→JWKS key, RS256 verify, `aud==client_id`, `iss` match,
`nonce` match, `exp>now`, `hd`/`tid` allowlist.

Group→role mapping: read a configurable `group_claim_name`; map to RBAC roles via
`group_role_map`; `default_role_if_no_group = viewer`.

Sources: https://developers.google.com/identity/openid-connect/openid-connect ·
https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc ·
https://tools.ietf.org/html/rfc7636 · https://pyjwt.readthedocs.io/

---

## 6. SMTP email alerting + provider presets

**Finding:** abstract a pluggable channel; email-first. `aiosmtplib` (async) or
stdlib `smtplib`. Port 587 = STARTTLS, 465 = SSL, 2525 = fallback. TLS 1.2+
everywhere. Gmail/M365 require OAuth2 XOAUTH2 or app passwords (Basic Auth retired).

Top-10 presets (host / port / encryption / auth):
- Gmail: `smtp.gmail.com` / 587 STARTTLS / xoauth2|app_password (2000/day)
- Microsoft 365: `smtp.office365.com` / 587 STARTTLS / xoauth2 (10000/day)
- Yahoo: `smtp.mail.yahoo.com` / 587|465 / app_password
- Zoho: `smtp.zoho.com` (or `smtppro.zoho.com`) / 587|465
- iCloud: `smtp.mail.me.com` / 587|465 / app-specific password
- SendGrid: `smtp.sendgrid.net` / 587|465|2525 / user=`apikey`, pass=API key
- Amazon SES: `email-smtp.{region}.amazonaws.com` / 587|465|25 / region creds
- Mailgun: `smtp.mailgun.org` / 587|465|2525 / user=postmaster@domain
- Postmark: `smtp.postmarkapp.com` / 587 / user=pass=Server API Token
- Brevo: `smtp-relay.brevo.com` / 587|465 / user=email, pass=SMTP key
- (+ generic host/port/encryption/user/pass; SparkPost, Mailjet as extras)

Operational design:
- **Dedup**: hash `(rule_id, entity_id, time_bucket)`, skip within window (default
  300s). Redis/in-memory state, TTL=window.
- **Rate-limit**: per recipient (default 100/day), exponential backoff on 429/5xx
  (1s,5s,10s,30s,60s).
- **Digest**: immediate for severity≥7 / escalation; batch the rest hourly into an
  HTML summary table.
- **Templating**: Jinja2 (or stdlib `str.format`); inline CSS; HTML + plain-text;
  fence untrusted log values as plain text.
- **Fire-and-forget**: async dispatch, never block case creation; audit the send
  optimistically.

Sources: https://learn.microsoft.com/.../how-to-set-up-a-multifunction-device... ·
https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp.html ·
https://pypi.org/project/aiosmtplib/ · https://docs.python.org/3/library/smtplib.html

---

## 7. Multi-source telemetry + cross-source correlation

**Finding:** two-tier correlation is standard: (1) intra-source clustering by
entity+rule (we do this), (2) cross-source clustering by SHARED ENTITIES within a
time window. Sentinel Fusion = 5-min default; Chronicle = variable 1–24h;
CrowdStrike = 15–300s. **Cross-source must be source-agnostic in its signature**
(entity type+value+time bucket, NOT rule name which varies per source).

Entity strength ordering for confidence weighting: USER > HOST > IP > FILE_HASH >
DOMAIN. Cross-source boost: 1.0 single / 1.3 two-source / 1.8 three+.

**Adopted:** per-SourceInstance `cross_source_correlation_enabled` opt-in (default
off — avoids false positives from unvetted sources); a second correlation pass that
groups clusters by entity+window; expose as related-cases, NOT a forced merge
(preserve 1:1 cluster→case + separate audit trails). This is exactly the "Auto-
Correlate toggle per source AND per sub-source" feature (F6); sub-source = the
per-IndexPattern `events`/`alerts` role already in the model.

Sources: Microsoft Sentinel Fusion docs · Google Chronicle SOAR docs · OCSF v1.4.0
entity taxonomy · CrowdStrike Falcon XDR correlation docs.

---

## 8. SOC console UI/UX (2025–2026)

- **Dark-mode default** (#0F172A bg, #F8FAFC text, #1E293B cards); validate WCAG AA
  (4.5:1 text, 3:1 UI). Avoid pure black.
- **Case detail layout**: summary header → KPI strip (MTTD/MTTR/alert count) →
  tabs (Overview/Alerts/Wall/Custom) → right-side panel (column manager/filters).
- **8px grid**; 14px body/20px line-height; table rows 40/48/56px.
- **Severity colors** temperature scale, ALWAYS paired with label+icon (color-blind
  safe). Critical <2% of alerts (avoid desensitization).
- **Loading**: skeleton + shimmer 1.5–2.5s; `animate-pulse` (2s); stagger 0.1s
  cascade; respect `prefers-reduced-motion` (motion-safe/motion-reduce); use
  `useOptimistic` for high-confidence mutations. SVG gauges via
  `stroke-dasharray`/`stroke-dashoffset`, transform/opacity only (compositor).

Sources: Google SecOps UX updates (medium.com/@thatsiemguy) · PatternFly status
tokens · NN/g skeleton screens · Tailwind/Motion docs · WCAG 2.2 C39.

---

## 9. Contextual help & onboarding (the (?) affordance)

- Tooltip (hover, <60 chars) vs Popover (click, rich/code/links) with
  auto-detection (`>60 chars || href || code → popover`).
- `HelpCircle` 16px in a `<button>` with `aria-label`. Radix Tooltip/Popover
  (already vendored in webui `ui/`). Escape closes, keyboard-navigable.
- Extend backend `AuthField` with `help` (already exists), `help_link`, `help_code`
  → drives per-connector help with zero per-connector frontend code.
- Empty-state guidance: "No sources" → Plug icon + "Connect your first source" CTA.
- First-run OOBE wizard (when `setup_complete=false`): Welcome → Connector →
  Configure → Data scope → LLM → Review, gated forward button.

Sources: Radix UI Tooltip/Popover docs · WCAG 2.1 AA contrast.

---

## 10. SOAR playbook automation & deterministic policy

**Finding:** triggers are 3 categories (event/scheduled/manual). Thresholds
(severity/risk/source/rule/tags, AND/OR) evaluated BEFORE execution. Execution is
sequential by order number; later rules see earlier mutations. **Playbooks must not
override analyst close decisions** — they gather evidence + recommend; high-risk
actions need human approval (HITL). Audit every run + decision with actor type.

**Adopted (without violating #3):** a playbook RUN is a CONTEXT-ONLY action
(re-investigate with the playbook injected); threshold automation matches a case
post-`decide()` and may TAG / set RECOMMENDATION / request approval / notify /
queue a playbook run — but it calls `decide()` again with new inputs, never sets
status directly. NEEDS_HUMAN never auto-closes regardless.

Sources: https://docs.splunk.com/Documentation/SOAR/current/PlaybookAPI/PlaybookAPI ·
https://learn.microsoft.com/en-us/azure/sentinel/automate-incident-handling-with-automation-rules

---

## 11. Threat context & reusable-knowledge enrichment

- Panel ordering: Verdict anchor → IOC reputation → MITRE techniques → related
  cases → asset context → threat actor → evidence.
- MITRE ATT&CK: cache the enterprise-attack JSON locally (quarterly updates); map
  `Case.mitre` → full technique records (id, name, tactics, platforms, sub-techs).
- IOC reputation: AbuseIPDB (`abuseConfidenceScore` 0–100), VirusTotal
  (malicious/total ratio). `is_malicious = score >= 50`. Thresholds tunable.
- Resolved-case knowledge loop: on CLOSE, auto-chunk the case into RAG
  (`source='resolved_case'`, metadata: entity_type, verdict, mitre, time-to-close)
  so "we've seen this before" surfaces on future investigations.
- Caching: IP 72h, MITRE 7d, resolved-case session, threat-actor 24h.

Sources: https://attack.mitre.org/techniques/enterprise/ ·
https://www.abuseipdb.com/api · https://developers.virustotal.com/reference/ip-object

---

## 12. Authentication hygiene (production)

- Password: NIST SP 800-63B baseline 8+, security products enforce 10–12 (users) /
  14+ (admins) with complexity. PBKDF2 ≥310k iters (we currently use 200k — bump
  recommended), 32-byte salt. Force change on first login.
- **Seed admin** `Admin` / `Admin@123` per the task (12 chars, complexity-OK) with
  **mandatory change on first login**.
- Access token 15min, refresh 7d (httpOnly secure cookie, rotation + reuse
  detection). Idle 8h.
- Login rate-limit: 5 fails → 30-min lockout, escalate to 2h on repeat; per-IP
  10/min, 100/h, exponential backoff.
- CSRF: per-session token in httpOnly cookie + `X-CSRF-Token` header, SameSite
  Strict/Lax, exempt GET/HEAD/OPTIONS. (Backend middleware exists; issue the cookie
  on login.)
- Audit all auth events (login/logout/failed/lockout/password-change/role-change),
  never log passwords/tokens. JWT secret ≥32 bytes from env.

Sources: https://pages.nist.gov/800-63-3/sp800-63b.html ·
https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html ·
OWASP CSRF/Rate-Limiting/Password-Storage cheat sheets.

---

## 13. Notification channels (beyond email)

Pluggable `NotificationChannel` ABC; email first, then Slack/Teams/PagerDuty/
Telegram/generic-webhook. All via `httpx` (already vendored), no SDK deps.
Standard event payload: `alert_id, case_id, severity, title, description, entity,
rule_name, risk_score, timestamp, case_url, verdict, confidence`. Idempotency via
`dedup_key`; per-channel rate limiters; async fire-and-forget; secrets in the
Secrets tier (UI shows `configured ✓` only).

Sources: Slack Incoming Webhooks · Teams connectors · PagerDuty Events v2 ·
Telegram Bot API · https://www.python-httpx.org

---

## 14. Case-ID nomenclature

- ServiceNow `INC` + 7 zero-padded digits (`^INC[\d]{7}$`); Jira `PREFIX-N` (no
  zero-pad); TheHive separates system UUID (`case_id`) from user-facing
  `case_number`; Splunk ES `V` + first 5 of MD5.
- Standard configurable parts: prefix, separator, date components (MM/YYYY),
  sequence reset period (none/calendar-year/fiscal-year/fiscal-quarter).
- **Adopted (F7):** keep `case_id` as immutable system id; add a configurable
  `case_number` rendered from a template (`CASE-{year}-{seq:06d}` default keeps the
  current look, e.g. `CASE-2026-000123`). Atomic sequence counter in the KV store,
  reset bucket per period. Live preview in settings. Old cases keep old ids
  (no migration; `case_id` is just a string).

Sources: ServiceNow record numbering docs · Atlassian Jira key format ·
TheHive case numbering · Elasticsearch (no AUTO_INCREMENT — app-layer counter).
