---
title: Troubleshooting
description: Diagnose Agentic SOC 0.1 startup, readiness, authentication, source, model, notification, and UI failures.
---

# Troubleshooting

Start with the narrowest failing layer. Preserve timestamps, build information, source
ID, request path/status, and sanitized logs. Never paste credentials, tokens, raw
sensitive events, or complete environment files into an issue.

## Backend is live but not ready

Check `/api/health/ready` and `/api/health/build-info`. A 503 readiness response means
the selected state store failed its usable/write-path probe.

- PostgreSQL: verify URL, DNS, TLS, credentials, database existence, and write rights.
- SQLite: verify the directory is writable and the file is not on unsuitable shared
  storage.
- Elasticsearch state: verify TLS/CA and the management key's rights to Agentic SOC-owned
  indices. Do not substitute the read-only log key.

## Login fails

- Confirm `AUTH_ENABLED` and the effective bootstrap/user configuration.
- Verify the backend uses the same stable JWT secret as before restart.
- Check whether the account is disabled, locked, or required to change its password.
- Confirm the user store is readable and readiness is healthy.
- For secure cookies, access the UI through HTTPS.
- For MFA, check system time and use a recovery code only through the supported flow.

## SSO callback fails

Compare the registered callback URI exactly, including scheme and path. Verify issuer,
client ID, provider metadata, client secret, browser cookies, and system time. An
unverified email or attempted unsafe link to a local account is expected to fail.

## Source is configured but no data appears

1. Inspect source health and coverage.
2. Confirm it is enabled and its feed role is not `ignore`.
3. Test the connector with the same endpoint/TLS settings.
4. Re-enter runtime-only secrets after a backend restart.
5. Validate time field, field mappings, index/stream scope, and severity/entity fields.
6. Check cursor lag, source retention, receiver acknowledgement, and per-tick caps.

Do not reset a source as a first diagnostic step; preserve cursor and mapping evidence.

## Investigation does not call a model

Check provider configuration/test results, model routing, the daily/monthly budget,
autopilot risk admission, per-tick caps, and whether the case is already queued/deferred.
A budget block should produce human-review work rather than drop the case.

## Notifications do not arrive

Preview the template, send a provider test, and inspect trigger, dedup, rate-limit, and
digest settings. Confirm the runtime secret survived the last restart and inspect the
receiving provider's rejection logs. Case persistence can succeed even when delivery
fails.

## UI is blank or stale

Verify backend readiness through the nginx `/api` proxy, then inspect browser network
status and console errors. Confirm the web and backend artifacts are both version
`0.1.8`. Clear only browser cache/site data needed to rule out stale assets; do not
factory-reset application state for a presentation problem.

## Escalation package

Provide sanitized build info, deployment shape, state backend, failing endpoint/status,
reproduction steps, relevant timestamps, expected/actual behavior, and whether the
problem reproduces with synthetic data. See [Security hardening](security.md) before
sharing diagnostics.
