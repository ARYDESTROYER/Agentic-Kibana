---
title: Security hardening
description: Apply least privilege, authentication, transport, prompt-safety, and operational controls to TLSOC 0.1.
---

# Security hardening

TLSOC processes attacker-influenced security telemetry and can call external model and
enrichment providers. Treat the backend, state store, credentials, and outbound network
as a security boundary.

## Minimum deployment controls

1. Enable authentication and RBAC.
2. Replace all demonstration/bootstrap credentials.
3. Set stable, random JWT and MFA keys outside Git.
4. Terminate HTTPS and set secure cookies.
5. Restrict backend and database network exposure.
6. Use separate read-only log and application-state credentials.
7. Restrict provider egress and webhook destinations.
8. Configure application and provider-side cost limits.
9. Back up and test restoration of state and deployment secrets.
10. Forward append-only audit records to an independently protected destination.

## Least-privilege source access

For Elasticsearch-compatible sources, the investigation key must be read-only and
limited to approved log patterns. A separate management key may read/write only
TLSOC-owned state indices. Never use a cluster superuser or `kibana_system`.

Apply the same principle to queue, object-store, cloud, and webhook credentials. A
receiver should access only the subscription, bucket/prefix, stream, or endpoint it
needs. Rotate credentials and confirm that failure does not acknowledge unpersisted
work.

## Authentication and sessions

Authentication is off by default, so network isolation alone is not a safe shared
deployment posture. After enabling it, use the smallest built-in/custom roles, MFA for
privileged accounts, short session policy, and session revocation during response.
Validate OIDC issuer, redirect URI, verified-email behavior, and client-secret storage.

Rate limiting is optional and process-local. It is not a replacement for an ingress
gateway or provider quota. CSRF support requires a client token exchange that the 0.1
web UI does not automatically complete; test it before enabling.

## Untrusted data and AI

Log-derived, source-derived, and user-influenceable values are untrusted. TLSOC fences
them in prompts and escapes them in the UI/template paths. Operator-imported knowledge
is also untrusted unless it belongs to a built-in verified corpus.

These controls reduce prompt-injection risk; they do not prove a model safe. Keep model
tools read-only, inspect traces, limit outbound access, and require human review for
response actions. The model supplies a verdict, while deterministic code applies the
configured close/escalate policy.

## Secrets and backups

UI-entered source, SSO, enrichment, and notification secrets are memory-only. Use a
deployment secret manager or protected environment injection for restart-safe operation.
Application backups do not contain those values. Protect backup encryption keys and
test restoring both state and secrets.

## Current limitations

Version 0.1 does not claim multi-tenant isolation, complete high availability, a
database migration framework, an integrated secret manager, or certification for every
advertised source protocol. Review [Known limitations](../releases/known-limitations.md)
and perform an environment-specific security assessment.

See [Authentication](../administration/authentication.md),
[Users and RBAC](../administration/users-rbac.md), and
[Health, backup, and restore](health-backup.md).
