---
title: Introduction
description: TLSOC is a source-available, self-hosted security operations console that turns detections and events into auditable cases.
---

# Introduction

<p class="tlsoc-page-lede">Security triage that explains every decision</p>

## What is TLSOC?

TLSOC is a vendor-neutral, self-hosted security operations console. It receives
alerts and events from many source types, normalises them to **OCSF**, correlates
related activity, and turns the result into a human-reviewable case.

AI can investigate compact, fenced evidence and return a verdict with confidence.
It never owns the final action: deterministic, operator-configured policy alone
decides whether a case closes, escalates, or needs a human.

## Key ideas

- **One source-neutral console** — pull from Elasticsearch, OpenSearch, or Wazuh;
  receive webhooks, HEC, syslog, queues, and object-store exports through one
  connector contract.
- **OCSF at the boundary** — native records become a canonical security-event
  shape before correlation, scoring, investigation, or case management sees them.
- **Cheap reasoning first** — rules, baselines, deduplication, and correlation keep
  routine telemetry away from expensive model calls.
- **AI with a cost boundary** — every model call uses compact, untrusted-data-fenced
  evidence and passes through one usage and cost ledger.
- **Code owns the final action** — a pure policy function, never model output, owns
  close and escalation decisions.
- **Built for review** — cases preserve provenance, investigation traces, status
  history, collaboration, and append-only audit records.

## Run locally

Start the deterministic four-source demo. It uses generated security stories and a
mock model, so it costs nothing and never touches a real source.

```bash
./scripts/run-demo.sh
```

Open `http://127.0.0.1:5173` and sign in with `Admin` / `Admin@123`.

## Components

| Component | Role |
| --- | --- |
| `tlsoc-backend` | FastAPI, LangGraph, connectors, deterministic policy, state, audit, and the cost ledger |
| `tlsoc-webui` | Standalone React security operations console and first-run setup |
| `StateStore` | PostgreSQL, SQLite, or Elasticsearch-backed suite bookkeeping |
| OCSF pipeline | Canonical event mapping before detection, correlation, and investigation |

## Next steps

- [Quickstart](getting-started/quickstart.md) — run the demo or evaluation stack
- [Ingestion and investigation](architecture/ingestion.md) — follow a signal from
  source receipt to deterministic case action
- [Source support](sources/support-matrix.md) — see what is implemented, emulated,
  or still planned
- [Known limitations](releases/known-limitations.md) — understand the Bleeding Edge
  evaluation boundary before connecting real data

The current planned artifact is **`v3.0.0-alpha.1`**. It is a single-replica
evaluation build, not a production certification.
