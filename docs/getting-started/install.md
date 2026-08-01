---
title: Install Agentic SOC
description: Start the recommended Agentic SOC 0.1 evaluation stack and verify its public health checks.
---

# Install Agentic SOC

This guide applies to **Agentic SOC 0.1** and is for operators installing the recommended
self-contained evaluation stack. It runs PostgreSQL with pgvector, Redis, the Agentic SOC
API, and the nginx-served Agentic SOC Console. Your SIEM or event source remains separate
and read-only.

## Prerequisites

- Docker Engine or Docker Desktop
- Docker Compose v2 (`docker compose`)
- enough local capacity for four containers and the state volume
- an Anthropic or OpenAI key, or a reachable OpenAI-compatible model, for real
  investigations
- a least-privilege credential if you plan to add a pull source

The deterministic demo does not require a provider key. See [Run the demo](demo.md)
when infrastructure and external model calls are not part of your evaluation.

## 1. Check out version 0.1

Use the immutable Stable tag:

```bash
git clone --branch v0.1.1 --depth 1 \
  https://github.com/ARYDESTROYER/Agentic-Kibana.git
cd Agentic-Kibana
```

For an unreleased preview, use the repository's `Testing` branch instead. The remote
now uses default `main` for accepted Stable source and has the `v0.1.1` tag. Do not
create or move a release tag locally. Pulling `main` means pulling the current
accepted Stable source—not the next Testing candidate—but repository protections
and required checks must be verified independently.

## 2. Prepare configuration

```bash
cp .env.example .env
```

At minimum, set a database password and stable authentication secret. Enable the
built-in authentication layer for any shared evaluation:

```dotenv
TLSOC_PG_PASSWORD=<random-database-password>
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<stable-random-secret-at-least-32-bytes>

# Choose one for non-demo investigations, or configure a compatible local model:
TLSOC_ANTHROPIC_API_KEY=
TLSOC_OPENAI_API_KEY=
```

Generate random values with `openssl rand -hex 32`. Never commit `.env`.

!!! warning "Secrets entered later in the UI"

    In Agentic SOC 0.1, runtime-entered source, notification, SSO, and local-model secret
    values live in process memory. They must be re-entered after a backend restart.
    Environment or an external deployment secret mechanism is the durable boot-time
    path.

## 3. Validate and start

```bash
docker compose -f deploy/docker-compose.agnostic.yml config --quiet
docker compose -f deploy/docker-compose.agnostic.yml up --detach --build
docker compose -f deploy/docker-compose.agnostic.yml ps
```

Open `http://localhost:8080` for a workstation evaluation. Terminate TLS at a trusted
ingress and set secure cookies before exposing the deployment beyond a trusted
network.

## 4. Verify the API

```bash
curl --fail http://localhost:8080/api/health/live
curl --fail http://localhost:8080/api/health/ready
curl --fail http://localhost:8080/api/health/build-info
```

- **Live** confirms the API process is running.
- **Ready** confirms the configured application-state store can serve requests.
- **Build info** reports the product version and build metadata without secrets.

Open **Documentation** from the bottom of the Console rail and confirm the browser
stays on this deployment at `/docs/0.1/`. That bundled Help Center matches the
installed application and remains usable without access to GitHub or the public docs
site.

If readiness fails, inspect the backend service logs and use the
[troubleshooting guide](../operations/troubleshooting.md).

## 5. Stop the stack

```bash
docker compose -f deploy/docker-compose.agnostic.yml down
```

The named PostgreSQL volume remains. Adding `--volumes` removes application state
and is destructive.

## Next steps

- [Complete first-run setup](first-run.md)
- [Create your first case](first-case.md)
- [Choose a source](../sources/support-matrix.md)
- [Harden the deployment](../operations/security.md)
