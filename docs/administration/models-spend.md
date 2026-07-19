---
title: Models and spend controls
description: Configure model routing, provider connectivity, pricing, and cost limits in TLSOC 0.1.
---

# Models and spend controls

Every LLM call passes through one gateway and produces a usage-ledger record. Model
selection controls quality and latency; the budget gate controls whether a new
provider call may begin. Neither can override the deterministic case decision.

## Configure providers

TLSOC supports configured catalog providers, cloud-specific provider settings, and
operator-registered OpenAI-compatible endpoints such as LiteLLM or self-hosted model
servers. Provider credentials remain in the secret tier.

Use **Models** to:

1. confirm that the intended provider is configured;
2. test connectivity with `/api/llm/models/test` or `/api/llm/providers/test`;
3. assign models to router, investigator, chat, and other configured roles;
4. review capability and pricing information;
5. estimate a call before applying a change.

A connectivity test is not a quality, privacy, or capacity certification. Validate
data-processing terms, regional routing, rate limits, context limits, and failure
behavior independently.

## Cost accounting

Usage records include input/output tokens and supported cache or batch adjustments.
Catalog prices can be overlaid by an administrator. Price overlays affect TLSOC's
estimate and ledger; they do not change provider billing.

Custom self-hosted/OpenAI-compatible models are represented as zero-priced unless an
operator supplies an appropriate accounting model. Zero in the TLSOC ledger does not
mean the infrastructure, GPU, network, or upstream proxy is free.

## Budget gate

The default balanced configuration enables a **$10 daily** LLM backstop, warns at
80%, and blocks new calls at the ceiling. Monthly limits are optional. When blocking
is selected, a denied investigation fails safe to `NEEDS_HUMAN`; the alert/case is not
dropped and the decision code does not auto-close it.

The budget check is a preflight comparison rather than an atomic reservation. Calls
already in flight may complete slightly beyond the configured limit. Configure
provider-side budgets and alerts as the final financial backstop.

## Change procedure

- Test a provider before routing production work to it.
- Change one role at a time and compare representative cases.
- Set explicit daily and provider-side limits.
- Monitor `/api/budget/status` and usage analytics.
- Keep a tested fallback model/provider.
- Treat model output and provider failures as evidence for human review, never as
  authority to bypass case policy.

Batch/flex modes can reduce provider cost but change latency and result ordering. They
are opt-in in version 0.1. See [Settings administration](settings.md) and
[Health, backup, and restore](../operations/health-backup.md).
