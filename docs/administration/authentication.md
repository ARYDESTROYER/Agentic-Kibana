---
title: Authentication
description: Configure local authentication, sessions, MFA, and OIDC SSO in Agentic SOC 0.1.
---

# Authentication

Agentic SOC supports local password authentication, signed sessions, TOTP MFA, recovery
codes, and OIDC sign-in. Authentication is **disabled by default** for compatibility
with isolated development and evaluation setups. Enable it before shared use.

## Enable authentication

At minimum, configure:

```dotenv
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<stable-random-secret-of-at-least-32-bytes>
TLSOC_AUTH_COOKIE_SECURE=true
```

`TLSOC_AUTH_COOKIE_SECURE=true` requires HTTPS. Keep the JWT secret stable across
restarts; changing or losing it invalidates existing sessions. Never commit it.

An empty user store may seed the documented demonstration administrator unless the
backend variable `AUTH_SEED_ADMIN=false` is set. The reference Compose files do not
expose a prefixed mapping for this advanced bootstrap switch, so add the unprefixed
variable explicitly to the backend service when disabling it. Do not retain
demonstration credentials in a real environment. Prefer the first-admin setup flow or
supply controlled bootstrap credentials, then rotate them immediately.

## Sessions

Access tokens carry a session identifier and token version. The session store applies
idle, absolute, revocation, and refresh-rotation checks. Users can inspect and revoke
their sessions; administrators can inspect the organization session registry and
revoke sessions for another user.

Use short access lifetimes appropriate to the environment. Session continuity also
depends on the selected state store and a stable JWT secret.

## MFA

TOTP setup returns a secret and recovery codes once. Store recovery codes outside the
application. Confirmation is required before MFA becomes active. Disabling MFA is a
sensitive operation and requires the authenticated account flow.

Agentic SOC obfuscates stored TOTP secrets with `MFA_OBFUSCATION_KEY`, or derives a key from
the JWT secret when no dedicated key is supplied. For a durable deployment, configure
a separate stable key and include it in secret backup procedures.

## OIDC SSO

Agentic SOC includes Google, Microsoft, and generic OIDC provider shapes. Configure provider
metadata as organization preferences and supply each client secret through the secret
tier. Register the callback URL ending in `/api/auth/sso/callback` at the identity
provider.

The callback validates browser-bound state. Email-based linking requires a verified
email and does not attach an SSO identity to a local-credential account merely because
the email strings match. Test sign-in and account-linking behavior with a non-admin
identity before rollout.

Runtime SSO secrets entered through the UI are memory-only. Supply them through the
deployment environment when restart persistence is required.

## Public routes and middleware

The setup status, login, refresh, SSO initiation/callback, liveness, readiness, and
branding bootstrap surfaces have narrowly scoped public behavior. The `/api` router
otherwise applies authentication centrally, and state-changing routes add permission
checks.

Security headers are enabled by default. Rate limiting is optional. The current CSRF
middleware requires clients to echo the expected token; the web UI does not complete
that exchange automatically in version 0.1, so do not enable CSRF without validating
the client flow.

See [Users and RBAC](users-rbac.md) and [Security hardening](../operations/security.md).
