---
title: Testing
description: Backend, Console, API-contract, version, documentation, and release validation gates for Agentic SOC 0.1.
---

# Testing

Agentic SOC changes are accepted on `Testing` only after the relevant offline, contract,
build, and documentation gates pass. Stable promotion moves that accepted source
tree through a protected pull request to `main`; the resulting commit is gated again
before application version `v0.1.0` is tagged.

The verified local baseline for this documentation update is **1,982 backend tests**
and **1,468 Console tests across 248 files**. Counts rise as coverage is added; the
commands and zero-failure result are the contract, not a frozen target.

The current remote has no literal `main`; it exposes `Testing` and legacy/default
`claude/main`. Repository provisioning and branch protection must be completed before
the Stable half of this workflow can run. Do not reinterpret `claude/main` as Stable
without changing the workflow and all release references consistently.

## Backend suite

The backend tests use fake Elasticsearch, mock model providers, and SQLite for SQL
repository coverage. They do not require production credentials or a live SIEM.

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
```

Run a focused file or test while iterating, then run the complete suite before
acceptance:

```bash
python -m pytest tests/test_api.py -q
python -m pytest tests/test_api.py::test_name -q
```

Tests that touch pipeline behavior should assert fail-safe human routing, audit writes,
usage ledger writes, cursor/idempotency behavior, and the deterministic case-manager
boundary as applicable. Every new state-changing route needs an authorization test.

## Console suite

Install exactly from the lockfile and run all product gates:

```bash
cd webui
npm ci
npm run typecheck
npm run lint
npm run gates
npm test
npm run build
```

Component/page tests should cover loading, empty, error, populated, and permission-
denied states. Interaction tests should use user-observable behavior and include
keyboard/focus/accessibility assertions where the component is interactive.

## API contract drift

The OpenAPI document and generated TypeScript contract are committed artifacts.
Regenerate them whenever a backend request, enum, or typed response changes:

```bash
cd webui
npm run gen:types
npm run check:types
```

`check:types` imports the backend and regenerates in place, then fails if the generated
bytes differ from the starting artifacts. Set `TLSOC_REQUIRE_TYPEGEN=1` in a lane where
missing backend dependencies must be treated as an error rather than a skip.

Review the generated diff. OpenAPI generation does not replace the hand-maintained
`src/lib/types.ts`, and endpoints without explicit `response_model` remain only partly
typed in the generated contract.

## Version consistency

Run the repository's standard-library metadata gate from the root:

```bash
python3 scripts/check_version.py
```

For the 0.1 line it checks that the root `VERSION` (`0.1.0`) agrees with backend,
Console, lockfile, OpenAPI, Compose image/build metadata, release records, and the
MkDocs/Mike documentation line (`0.1`).

## Documentation

Use the same version-matched bundler the Console build invokes:

```bash
cd webui
npm run docs:bundle
npm run docs:check
npm run build
```

The wrapper runs MkDocs in strict mode and reuses `TLSOC_DOCS_PYTHON`, a compatible
backend/current interpreter, or an automatically bootstrapped ignored `.docs-venv`.
The final `npm run build` is the canonical docs-plus-application acceptance gate;
`npm run build:app` alone is insufficient for release acceptance. Strict mode catches
missing pages, invalid internal links, and configuration warnings.
Review the rendered desktop and narrow layouts, dark/light themes, search, navigation,
code copy, the installed `/docs/0.1/` base path, and the public 0.1 version selector.
Confirm that **Use the product** is the default navigation path and that in-app links
stay on the application origin. Internal development records are deliberately excluded
from the Help Center build.

## Deployment-shape checks

Validate Compose interpolation without starting services:

```bash
docker compose -f deploy/docker-compose.agnostic.yml config
docker compose -f deploy/docker-compose.tlsoc.yml config
```

Provide required placeholder environment values through a temporary untracked
environment when running these commands. For a release candidate, additionally test
the selected real state backend, restart persistence, source authentication, readiness,
backup/restore, Console proxying, SSE reconnect, and provider failure behavior in an
isolated environment.

## Release acceptance

Before promoting `Testing` to Stable:

1. Rebase/merge the intended feature changes into `Testing` and identify the candidate commit.
2. Run backend, Console, generated-contract, version, strict-docs, and packaging/deployment checks.
3. Resolve every failure on `Testing`; do not patch only the Stable branch.
4. Promote the accepted source tree to `main` without content changes, then run the
   release gate again on the resulting `main` commit.
5. Build and stamp the verified commit with the correct channel, exact SHA, build
   date, and source URL.
6. Create the immutable `v0.1.0` tag and publish matching artifacts by digest and
   the matching versioned documentation from that verified commit.
7. Verify `/api/health/build-info`, image metadata, and the 0.1 Stable docs selector.

See [Development](index.md), [Compatibility](../reference/compatibility.md), and
[Release channels](../releases/channels.md).
