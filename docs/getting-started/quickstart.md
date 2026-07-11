---
title: Quickstart
description: Run the deterministic local demo or start the self-contained evaluation stack.
---

# Quickstart

Choose the local demo when you want to see the workflow without infrastructure or
model spend. Choose the Compose stack when you are ready to evaluate a real,
read-only source.

!!! warning "Use non-production data for this alpha"

    Version `3.0.0-alpha.1` is a single-replica evaluation build. Dynamic source
    secrets entered in the UI are memory-only, and push ingestion does not yet have
    a durable receipt/inbox. Read [known limitations](../releases/known-limitations.md)
    before connecting a source.

## Local demo

The demo runs the backend on port `8088` and the Vite web console on `5173`. The
script waits for readiness, completes the local setup, and enables an isolated
seeded Demo Mode with generated OCSF events and a deterministic mock model.

### Requirements

- Python 3.11
- Node.js 22 and npm
- macOS or Linux with Bash

```bash
git clone --branch v3.0.0-alpha.1 --depth 1 \
  https://github.com/ARYDESTROYER/Agentic-Kibana.git
cd Agentic-Kibana
./scripts/run-demo.sh
```

The tag becomes available only after the release blockers close and the alpha is
published. Contributors evaluating an unreleased checkout should use their existing
branch instead of inventing or moving this tag.

Open [http://localhost:5173](http://localhost:5173) and sign in with the demo-only
account shown by the script. In the current build the seed is:

```text
Username: Admin
Password: Admin@123
```

Change or remove this account before using any real data. Stop both processes with
<kbd>Ctrl</kbd>+<kbd>C</kbd>.

!!! tip "No provider key required"

    The mock provider is enough for the tour. Export `ANTHROPIC_API_KEY` or
    `OPENAI_API_KEY` before running the script only when you deliberately want to
    exercise a paid provider.

## Evaluation stack

The primary deployment shape contains PostgreSQL + pgvector for application state,
Redis for enrichment caching, the FastAPI backend, and the standalone nginx-served
web console. Your SIEM is not bundled and is never modified.

### Requirements

- Docker Engine or Docker Desktop
- Docker Compose v2 (`docker compose`)
- An Anthropic or OpenAI key, or a reachable OpenAI-compatible local model
- A read-only source credential when using a pull connector

### 1. Prepare configuration

```bash
git clone --branch v3.0.0-alpha.1 --depth 1 \
  https://github.com/ARYDESTROYER/Agentic-Kibana.git
cd Agentic-Kibana
cp .env.example .env
```

Set at least the following values in `.env`:

```dotenv
TLSOC_PG_PASSWORD=<random-database-password>
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<stable-random-secret-at-least-32-bytes>
TLSOC_AUTH_ADMIN_USERNAME=admin
TLSOC_AUTH_ADMIN_PASSWORD=<unique-admin-password>

# Choose at least one, unless you configure a local compatible model:
TLSOC_ANTHROPIC_API_KEY=
TLSOC_OPENAI_API_KEY=
```

You can generate suitable random values locally with `openssl rand -hex 32`. Do
not commit `.env`. For an HTTPS deployment, also set
`TLSOC_AUTH_COOKIE_SECURE=true`; the local HTTP evaluation remains `false`.

### 2. Validate and start

```bash
docker compose -f deploy/docker-compose.agnostic.yml config --quiet
docker compose -f deploy/docker-compose.agnostic.yml up --detach --build
docker compose -f deploy/docker-compose.agnostic.yml ps
```

Open [http://localhost:8080](http://localhost:8080). Check the public probes before
continuing:

```bash
curl --fail http://localhost:8080/api/health/live
curl --fail http://localhost:8080/api/health/ready
curl --fail http://localhost:8080/api/health/build-info
```

- **Live** confirms the API process is running.
- **Ready** confirms the selected application-state store is usable and returns
  HTTP `503` when it is not.
- **Build info** reports the product version and build metadata without exposing
  secrets.

### 3. Add one source

Start narrowly so provenance and field mapping are easy to verify:

1. Open **Settings → Sources → Add source**.
2. Choose a connector marked available in the [support matrix](../sources/support-matrix.md).
3. For a pull source, provide a credential restricted to read and metadata access
   on the intended log indices. Never use a superuser or service-system account.
4. Configure one alert feed or one small event index pattern.
5. For a pull source, use **Test connection** before saving. The alpha tests the
   selected connector with its current draft configuration and secrets without
   persisting those values. Push/broker receivers do not support a meaningful
   one-shot probe; save them and use source health plus the end-to-end check.
6. Save the source.
7. Send a synthetic test alert and confirm its source, timestamp, rule, entities,
   severity, and raw provenance in the console before widening the scope.

For a webhook, select bearer or HMAC authentication and post JSON, NDJSON, CEF,
LEEF, GELF, or key/value data to:

```text
POST /api/ingest/<source-id>
```

The sender must retry non-success responses. UI-entered bearer/HMAC secrets must be
re-entered after a backend restart in this alpha.

### 4. Observe the pipeline

Use these checks during the first run:

- **Sources** shows connection and recent coverage signals.
- **Unified logs** confirms normalisation and source attribution.
- **Cases** separates what the source reported, what the investigator found, and
  what deterministic code decided.
- **Cost** records every model call through the shared gateway.
- **Audit** records state-changing agent and analyst actions.

### 5. Stop or reset

```bash
docker compose -f deploy/docker-compose.agnostic.yml down
```

PostgreSQL state remains in the named volume. To remove the evaluation database as
well, add `--volumes`; that is destructive and cannot be undone.

## Before internet exposure

This quickstart is not a production hardening guide. At minimum, wait for the
[release blockers](../releases/known-limitations.md#release-blockers), terminate TLS
at a trusted ingress, restrict backend and receiver ports, rotate all seed/default
credentials, set secure cookies, use least-privilege source identities, back up the
state store, and establish restore tests.

The full operator reference remains in
[DEPLOY.md](https://github.com/ARYDESTROYER/Agentic-Kibana/blob/HEAD/DEPLOY.md) while
the public operations guide is being decomposed for the documentation site.
