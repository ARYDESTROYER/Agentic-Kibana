---
title: Notifications
description: Configure channels, triggers, templates, digests, and delivery tests in Agentic SOC 0.1.
---

# Notifications

Agentic SOC can deliver email, Resend, Slack, Microsoft Teams, generic webhook,
PagerDuty, Telegram, and in-app notifications. Notifications run after case state is
saved and never determine whether a case closes or escalates.

## Configure a channel

1. Open **Settings → Notifications**.
2. Choose a provider/channel type.
3. Configure non-secret routing fields and trigger conditions.
4. Enter the channel secret or webhook URL in the secret field.
5. Preview the template.
6. Send a test notification.
7. Enable the channel only after delivery is confirmed.

`GET /api/notifications/providers` returns the provider catalog.
`POST /api/notifications/preview` renders an unsaved template safely, and
`POST /api/notifications/test` performs a test send. Per-channel secrets use
`POST /api/notifications/channels/{channel_id}/secret` and are never returned.

## Templates and safety

Agentic SOC includes a bounded mustache-style template system. Rendered variables are
escaped by default, and raw insertion is restricted to trusted keys. Keep subjects
header-safe, avoid sensitive evidence in broad channels, and preview every template
after adding user-, case-, or source-derived fields.

## Delivery behavior

The dispatcher supports condition-based triggers, deduplication, rate limiting, and
digest behavior. Delivery is best-effort: a downstream outage must not roll back the
case decision. Monitor both the Agentic SOC audit/notification state and the receiving
provider.

In-app notifications are stored per user in a bounded inbox. Users can control their
notification preferences, mark items read, dismiss them, or mark all read.

## Secret persistence

Notification credentials entered through the UI are memory-only and disappear on
backend restart. For restart-safe operation, provide the notification secret map via
the deployment environment and protect it like any other credential.

## Operational checklist

- Use a low-privilege sender identity.
- Restrict webhook destinations and rotate their tokens.
- Test escaping with adversarial-looking case/source text.
- Set provider-side rate limits and failure alerts.
- Confirm deduplication and digest expectations before enabling high-volume triggers.
- Re-test after changing templates, channels, proxy rules, or certificates.

See [Configuration reference](../operations/configuration.md) and
[Troubleshooting](../operations/troubleshooting.md).
