---
title: First-run setup
description: Configure identity, sources, model providers, and safe defaults in the Agentic SOC setup flow.
---

# First-run setup

This guide applies to **Agentic SOC 0.1** and is for administrators opening a new Agentic SOC
Console for the first time. The console shows setup instead of the operational
workspace until the deployment is marked complete.

## Before you begin

Have the following ready:

- a unique administrator password;
- one source and a synthetic event you can safely send;
- a read-only source credential for a pull connector, or an authentication secret
  for a push receiver; and
- a model-provider key, unless you are using Demo Mode or a compatible local model.

## 1. Secure the administrator account

When authentication is enabled and no user exists, Agentic SOC can bootstrap an initial
administrator. If the deployment presents the seeded `Admin` account, replace its
default password immediately and create named accounts before connecting real data.
Never retain demo credentials on a shared deployment.

For role design, MFA, SSO, and session policy, see
[Identity and access](../administration/users-rbac.md).

## 2. Welcome

Name the deployment and review the operating model. Demo Mode is optional and uses
isolated synthetic data with a deterministic `$0` model. It is not a connection test
for a real source.

## 3. Add a source

The source editor is driven by connector manifests. It renders the connection,
authentication, feed, and mapping fields supported by the selected connector.

1. Choose an implemented connector from the [support matrix](../sources/support-matrix.md).
2. Give the source a stable ID and a recognizable display name.
3. Configure the transport and non-secret fields.
4. For a pull source, use a credential restricted to read and index-metadata access
   on the intended patterns. Never use a superuser or service-system account.
5. Configure one narrow feed first.
6. Use **Test connection** for Elasticsearch, OpenSearch, or Wazuh.
7. Save a push receiver, send a synthetic event, and inspect source health instead;
   push and broker receivers do not have a meaningful one-shot connection test.

Secret values are not returned to the console. The source record stores only which
secret field names are configured.

## 4. Configure model providers

Add at least one provider for real investigations and assign models to the roles
shown by the console. A self-hosted OpenAI-compatible endpoint can be registered
from the Models settings.

Every provider call passes through the shared cost ledger. The default daily budget
is a preflight ceiling, not a provider-side billing limit; configure provider-side
budgets as a second boundary.

## 5. Review and finish

Review the source scope, model assignments, authentication state, and cost limit.
Completing setup starts enabled pull polling and reconciles enabled background
receivers.

## Verify setup

After the workspace opens:

- **Sources** lists the new source and its enabled state;
- source coverage or health shows a successful poll or recent event;
- **Unified logs** shows the expected normalized fields;
- **Cost** is zero until a model-backed action runs; and
- **Audit** records later state-changing actions.

!!! warning "Do not widen scope yet"

    Validate timestamp, native ID, rule, severity, user, host, address, and source
    provenance with synthetic data before adding broad event patterns. Mapping
    mistakes at this stage can create misleading correlations and cases.

## Next steps

- [Create your first case](first-case.md)
- [Understand feeds and mapping](../sources/feeds-mapping.md)
- [Understand deterministic decisions](../concepts/deterministic-decisions.md)
