---
title: Settings administration
description: Configure Agentic SOC 0.1 safely, understand preference scope, and keep secrets out of persisted settings.
---

# Settings administration

Agentic SOC separates ordinary preferences from credentials. This distinction matters:
preferences are durable application state, while credentials belong to the secret
tier and are never returned to the browser.

## Who can change settings

When authentication and RBAC are enabled, `super_admin` and `soc_manager` have the
built-in ability to manage settings. Other built-in roles can read settings but
cannot change them. Custom roles can grant narrower management rights for models,
notifications, branding, enrichment, terminology, automation, and rules.

When authentication is disabled, route-level authorization is intentionally a
no-op. Enable authentication before exposing a deployment to other users or a
network you do not fully trust.

## Configuration layers

| Layer | Examples | Persistence |
|---|---|---|
| Environment | state database URL, JWT signing key, provider credentials | supplied by the deployment; never written by Agentic SOC |
| Organization preferences | sources, case policy, model routing, budgets, automation, branding | selected `StateStore` |
| User preferences | theme, saved views, table columns | selected `StateStore`, scoped by user |
| Runtime secret tier | source, SSO, and notification secrets entered through the UI | memory only; lost when the backend restarts |

The Settings UI is the preferred editing surface. The API exposes `GET /api/settings`,
`GET /api/settings/schema`, and `PUT /api/settings`; writes are validated as a complete
`Preferences` model. Do not send a stale full settings document from an external
script: another administrator may have changed a different section in the meantime.

The Console presents one searchable section rail, a single active-section heading,
and flat divider-led setting groups. Theme selection is a compact **System / Light /
Dark** control under **Account → Appearance & customization**. Personal theme changes
apply immediately and follow the signed-in user; System follows the organization
default when one is configured, otherwise the device preference.

## Safe administration sequence

1. Back up the application state before a broad policy change.
2. Change one section at a time.
3. Use built-in preview or test actions where available.
4. Confirm the effective value after saving.
5. Inspect the audit trail and relevant health page.
6. Keep a rollback value for detection, automation, and model-routing changes.

Rules have their own version ledger and rollback controls. Threshold tuning also
keeps an application ledger. General preference documents do not provide universal
point-in-time rollback in version 0.1.

## High-impact areas

- **Sources and ingestion:** changing identifiers, feeds, field mappings, or source
  roles affects future collection. It does not rewrite closed cases.
- **Case policy:** the deterministic case manager remains the sole close/escalate
  authority. `NEEDS_HUMAN` can never auto-close; true-positive auto-close is off
  unless an operator explicitly enables it.
- **Autopilot and budget:** the balanced profile enables broad collection and a
  default daily LLM budget backstop. A budget block routes work to a human; it does
  not discard or silently close the case.
- **Reset:** reset actions are separate, freshly authenticated, type-to-confirm
  operations. See [Reset and recovery](reset.md).

## Export portable application state

Open **Settings → Organization → Data export** when support or offline analysis
needs a bounded JSON snapshot. Select all safe scopes or any combination of cases,
audit, usage, configuration, automation, and knowledge. `limit_per_scope` is an
aggregate cap for each selected scope (1–5000, default 1000); the returned manifest
states count, known total, and truncation.

The export excludes environment/source credentials, users and sessions,
password/MFA material, browser tokens, upstream raw logs, and raw knowledge chunks.
It is capped at 25 MiB and is not an import format or backup/restore mechanism. Every
request is audited and requires `data_export:export`, granted by default to
`super_admin` and `soc_manager`. Use a custom role only after reviewing the exact
data that the selected scopes disclose.

## Secrets

Use environment variables for restart-safe credentials. A value entered into a
source, notification, enrichment, or SSO secret form is held in memory and represented
later only as a configured/not-configured state. Plan to re-enter those values after
a backend restart unless the deployment supplies them at boot.

Continue with [Configuration reference](../operations/configuration.md),
[Authentication](authentication.md), and [Health, backup, and restore](../operations/health-backup.md).
