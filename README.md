# Agentic SOC

Agentic SOC is a self-hosted, vendor-agnostic security operations platform that
turns high-volume alerts into explainable, audited, human-reviewable cases.

It connects to existing security data, normalises records to OCSF, correlates and
risk-scores them deterministically, uses role-separated AI investigation, and applies
operator policy through a deterministic case manager. The model can recommend a
verdict; it cannot decide to close or escalate a case.

> **Version 0.1.2 beta patch · Testing integration → `main` Stable**
> Start with the [Quickstart](docs/getting-started/quickstart.md), or open the
> version-matched Help Center from inside the Console.

## What Agentic SOC delivers

- **One case workflow:** ingest, cluster, investigate, collaborate, decide, and audit
  without moving between disconnected tools.
- **Vendor-agnostic sources:** pull from Elasticsearch, OpenSearch, and Wazuh; receive
  supported HTTP, syslog, queue, and object-store events through connector interfaces.
- **OCSF-normalised evidence:** source records enter one canonical schema before
  correlation or model use.
- **Explainable investigation:** the Case Manager keeps source facts, agent findings,
  risk factors, provenance, timeline, threat context, collaboration, and chat together.
- **Deterministic control:** code—not a model, prompt, runbook, or playbook—owns the
  final close/escalate decision.
- **Measured AI spend:** every model call crosses one gateway and produces a usage and
  cost record. Fresh workspaces use OpenAI GPT-5.6 Luna for completion roles; models
  and providers remain configurable.
- **Operational intelligence:** runbooks, playbooks, enrichment, operator memory,
  knowledge retrieval, MITRE ATT&CK context, campaigns, baselines, and auto-tuning.
- **Built for teams:** RBAC, MFA, SSO, sessions, notifications, case collaboration,
  audit history, saved views, and per-user chat history.
- **Selectable state:** PostgreSQL with pgvector, Elasticsearch, or SQLite.
- **A complete standalone Console:** responsive light and dark themes, first-run setup,
  live dashboards, Cases, Case Manager, Analytics, Intelligence, Settings, and bundled
  documentation.

## Safety model

The core guardrails are architectural contracts, not prompt instructions:

| Contract | What it means |
| --- | --- |
| Read-only source access | Pull connectors use narrowly scoped credentials and do not modify the upstream log platform. |
| Deterministic case authority | Only operator-configured code can close or escalate; uncertain cases route to a human. |
| Untrusted-data fencing | Source-controlled and user-influenced values are labelled and fenced before model use. |
| Complete cost accounting | Every model call passes through one gateway and enters the cost ledger. |
| Durable processing | Cursors and cluster signatures prevent silent skips and duplicate cases. |
| Append-only accountability | Agent and operator actions are preserved in the audit history. |
| Secrets stay secret | Secret values remain in the environment or runtime secret tier; the UI receives configured-state booleans only. |
| Graceful degradation | Optional enrichment and external services fail safely without bypassing human review. |

Read the full [security model](SECURITY.md) and
[deterministic-decision contract](docs/concepts/deterministic-decisions.md) before
connecting production data.

## Architecture

```text
Security sources
  │
  ├─ pull connectors
  └─ push / queue / object-store receivers
  │
  ▼
OCSF normalisation
  │
  ▼
Correlation → risk → budget gate
  │
  ▼
Single model gateway → router → investigator → formatter
  │                         │
  │                         └─ tools, enrichment, knowledge, runbooks
  ▼
Deterministic Case Manager
  │
  ├─ cases and collaboration
  ├─ audit and usage ledgers
  └─ PostgreSQL + pgvector | Elasticsearch | SQLite
  │
  ▼
Agentic SOC Console and API
```

The FastAPI backend owns connectors, OCSF conversion, agent orchestration, policy,
authentication, persistence, and the API. The Vite/React Console is the primary and
only supported operator surface. The retired Kibana plugin remains archived and is
not built, tested, or shipped.

See [Architecture](docs/concepts/architecture.md) for the complete request and data
flow.

## Explore locally

The deterministic demo is the fastest way to see the full workflow. It generates
isolated multi-source security stories and forces a `$0` mock model, even if provider
keys exist.

Requirements: Python 3.11, Node.js 22, npm, and Bash on macOS or Linux.

```bash
./scripts/run-demo.sh
```

Open <http://127.0.0.1:5173>. The standard demo account is
`Admin` / `Admin@123`. Stop both processes with `Ctrl+C`.

Demo credentials are for loopback evaluation only. Never expose or reuse them with
real data. Continue with the [Demo guide](docs/getting-started/demo.md) and
[first-case walkthrough](docs/getting-started/first-case.md).

## Run the standalone evaluation stack

The recommended Compose stack runs PostgreSQL with pgvector, Redis, the backend, and
the nginx-served Console. Connected security systems remain separate.

```bash
cp .env.example .env
# Configure unique database, authentication, and provider secrets in .env.

docker compose -f deploy/docker-compose.agnostic.yml config --quiet
docker compose -f deploy/docker-compose.agnostic.yml up --detach --build
docker compose -f deploy/docker-compose.agnostic.yml ps
```

Open <http://localhost:8080>, complete first-run setup, and verify the service:

```bash
curl --fail http://localhost:8080/api/health/live
curl --fail http://localhost:8080/api/health/ready
curl --fail http://localhost:8080/api/health/build-info
```

Stop the stack without deleting its named state volume:

```bash
docker compose -f deploy/docker-compose.agnostic.yml down
```

Use the [installation guide](docs/getting-started/install.md) for prerequisites and
the [deployment guide](DEPLOY.md) for TLS, secrets, backups, authentication, source
credentials, and production hardening.

## Configure real data

1. Begin with one narrow, least-privilege source credential.
2. Map and inspect a representative non-sensitive record.
3. Confirm source identity, timestamp, rule, severity, entities, and provenance.
4. Verify the resulting case, model cost, and audit history.
5. Widen the source scope only after the complete path is correct.

Configuration has two layers:

- **Environment secrets:** copy [`.env.example`](.env.example); never commit the
  resulting `.env` file.
- **Operator preferences:** use the first-run wizard and **Settings** for sources,
  models, policy, automation, enrichment, notifications, identity, retention, and
  release discovery.

Useful references:

- [Supported sources](docs/sources/support-matrix.md)
- [Configuration reference](docs/reference/configuration.md)
- [Models and spend](docs/administration/models-spend.md)
- [Authentication and identity](docs/administration/authentication.md)
- [Health and backup](docs/operations/health-backup.md)
- [Known limitations](docs/releases/known-limitations.md)

## Repository map

```text
backend/       FastAPI, agent graph, connectors, OCSF, policy, stores, tests
webui/         React/TypeScript Console, design system, bundled Help Center
deploy/        Compose definitions, mappings, and deployment assets
docs/          Versioned operator, analyst, administration, and developer guides
scripts/       Local demo, release, documentation, and validation helpers
archive/       Frozen unsupported legacy surface
```

## Develop and verify

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before changing
the system. Keep deterministic case authority, API compatibility, auditability,
accessibility, and the Journal workflow intact.

Backend:

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
```

Console:

```bash
cd webui
npm ci
npm test
npm run check:types
npm run lint
npm run gates
npm run build
```

Tests use fake stores and mock models where appropriate; backend tests must remain
offline. The Console build type-checks the application and bundles documentation that
matches the application version.

## Documentation

| Need | Start here |
| --- | --- |
| Use the product | [Help Center](docs/index.md) |
| Evaluate quickly | [Quickstart](docs/getting-started/quickstart.md) |
| Operate cases | [Case Manager guide](docs/analyst/case-manager.md) |
| Author intelligence | [Runbooks](docs/intelligence/runbooks.md) |
| Deploy and operate | [Deployment](docs/operations/deployment.md) |
| Troubleshoot | [Troubleshooting](docs/operations/troubleshooting.md) |
| Integrate the API | [API reference](docs/reference/api.md) |
| Understand releases | [Release channels](docs/releases/channels.md) |
| Continue development | [Developer handoff](docs/HANDOFF.md) |

The Help Center bundled with a running Console is authoritative for that installed
version. Public repository documentation may describe a different channel.

## Contributing, security, and license

- Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md), including branch, test,
  documentation, and Journal requirements.
- Community participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities through the private responsible-disclosure process in
  [SECURITY.md](SECURITY.md). Do not open a public issue for an undisclosed weakness.
- This repository does not currently publish a license file. Source availability does
  not grant permission to use, modify, or redistribute the code. Add an explicit
  license before representing the project as open source.

Release history is in [CHANGELOG.md](CHANGELOG.md); planned work is tracked in
[ROADMAP.md](ROADMAP.md).
