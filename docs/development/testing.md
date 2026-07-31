---
title: Testing
description: Backend, Console, API-contract, version, documentation, and release validation gates for Agentic SOC 0.1.
---

# Testing

Agentic SOC changes are accepted on `Testing` only after the relevant offline, contract,
build, and documentation gates pass. Stable promotion moves that accepted source
tree through a protected pull request to `main`; the resulting commit is gated again
before application version `v0.1.1` is tagged.

The latest fully recorded local baseline is **2,174 backend tests** and **1,828
Console tests across 277 files**. Counts rise as coverage is added; the
commands and zero-failure result are the contract, not a frozen target.

The current remote has no literal `main`; it exposes `Testing` and legacy/default
`claude/main`. Repository provisioning and branch protection must be completed before
the Stable half of this workflow can run. Do not reinterpret `claude/main` as Stable
without changing the workflow and all release references consistently.

## GitHub merge gate

Every pull request receives twelve visible statuses from
`.github/workflows/ci.yml`: repository/version contracts, backend tests, backend
package integrity, backend startup, Console tests, TypeScript/OpenAPI drift,
Console lint, design-system gates, Help Center/docs, the production Console build,
deployment/shell contracts, and the aggregate **CI passed** result. The first eleven
run independently so the failed contract is obvious; the aggregate runs even when a
dependency fails or is cancelled and succeeds only when all eleven report success.

Branch protection needs only the stable aggregate name **CI passed**. Requiring that
single fail-closed result keeps protection intact if an internal job is renamed while
still preventing a skipped or cancelled lane from passing a merge. The exact job-to-
command mapping is maintained in the repository's root `CONTRIBUTING.md`.

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

### Release-candidate browser acceptance

The complete Console suite is necessary but does not replace browser acceptance. For
every Stable candidate, inspect the exact built candidate through the supported same-
origin proxy and record the build SHA, application/channel badge, browser, viewport,
theme, and result in a dated release receipt. Use at least one desktop viewport at or
above 1280 CSS pixels and one narrow viewport at or below 767 CSS pixels. Exercise
Light, Dark, and System; System must be checked against both device preferences across
the receipt or linked automated evidence.

| Area | Required browser path |
| --- | --- |
| Identity and setup | Sign-in username → password flow, optional demo/SSO controls when configured, theme switch, error/retry, software-keyboard-safe narrow layout, first-run setup progress/content/footer, and close/re-run behavior |
| Overview | Dashboard time/refresh controls, KPI and case drill-down, Latest Cases hover and focus detail, Noise Reduction expand/close, custom Dashboards, and Standup |
| Triage | Cases filters/table/loading and exact Case Manager handoff; Case Manager Active/All queue, resize/keyboard reset, selection/bulk menu, Overview/Timeline/Investigation/Threat context/Collaboration/Chat tabs, Campaigns, Logs, Workspace Chat/history, Entity investigation, and Approvals |
| Intelligence and analytics | Knowledge, Memory, Playbooks browse/edit boundaries, Metrics, Agent effectiveness, Cost, Models, Baseline, Batch jobs, and Auto-tuning Operations/Outcomes/Policy & history |
| Platform and help | Sources catalog/detail/health, Audit log, Settings section search/deep links/dirty state/sticky actions, narrow Settings Sheet, appearance/branding isolation, and the in-app Help Center plus an installed `/docs/<major.minor>/` article |
| Release activation | Current release badge/popover; coherent different `/release.json` offer; confirmation/focus return; known-dirty blocking; stale-target, identity-mismatch, unhealthy, offline, and invalid-entry preflight failures; successful same-hash-route activation |
| Compatibility paths | Hidden or consolidated bookmarked routes load or redirect to their documented replacement without reappearing in primary navigation |

For Auto-tuning, verify Collecting/Within target/Needs attention classification,
search and state filters, inspector open/close, one grouped action per rule, mixed
safe/restricted outcomes, same-rule busy locking with unrelated rules still enabled,
permission-isolated Outcomes loading, dirty policy preservation, newest-active
rollback, and no horizontal overflow in Light/Dark desktop and 390px layouts.

For release activation, run against a deployment fixture that can independently
control `/release.json`, `/api/health/build-info`, `/api/health`, and `/index.html`.
Confirm the action is absent for the loaded build and every incomplete/incoherent
combination. Offer it only for a different exact manifest/backend identity with
healthy readiness. After the dialog opens, change the target or fail each final
preflight request in turn; the old document and current work must remain usable and
must not enter a request/reload loop. Verify a known dirty Runbook or Settings draft
removes the Update action, the native exit guard still covers the actual navigation,
cancel restores focus, and a successful activation retains the exact hash route. Run
the case with the previous hashed asset set retained (or against blue-green static
origins) and prove an open tab can lazy-load both before and during the observation
window. The browser must never receive a deployment credential or invoke a pull,
restart, migration, promotion, or rollback path.

For each area, verify the states that can be reproduced safely: loading, populated,
empty, refresh-in-place, retryable failure, permission denied/hidden navigation, and
confirmation/progress for consequential actions. Use keyboard-only navigation through
the rail/flyouts, tabs, menus, dialogs, Sheets, table controls, and the Case Manager
divider; confirm visible focus and Escape/focus-return behavior. Hover/focus details
must remain reachable without clipping.

At both widths, reject horizontal page overflow, overlapping sticky regions, scroll
jumps, clipped menus, duplicate headings/actions, blank lazy-route canvases, competing
spinners, theme flashes, and content hidden beneath the composer or footer. Keep the
browser console and network panel open: unexplained runtime errors, rejected chunks,
failed same-origin API/docs requests, or repeated request loops fail acceptance.

The receipt may link screenshots rather than embedding every view, but it must identify
the corrected or high-risk surfaces and state that no unexplained console/network error
remained. Re-run the focused browser path after a fix and repeat the complete matrix on
the final promoted `main` commit before tagging.

### Known test-harness noise

The complete Console suite currently passes without failures. Its jsdom output has
**152** Recharts zero-dimension notices and **168** React/Radix `act(...)` notices;
there are **0** controlled-state transitions, error heads, or unimplemented-runtime
errors. These are test-harness cleanup items rather than accepted product errors. Do
not suppress them globally; remove each notice at its owning fixture or component so
new regressions remain visible.

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

For the 0.1 line it checks that the root `VERSION` (`0.1.1`) agrees with backend,
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
TLSOC_PG_PASSWORD=validation-only \
  docker compose -f deploy/docker-compose.agnostic.yml config --quiet
bash -n scripts/run-demo.sh
```

`deploy/docker-compose.tlsoc.yml` is deliberately a fragment to merge into an
operator's existing ELK project; validating it as a standalone topology would be a
false failure because its Elasticsearch service is external. For a release candidate, additionally test
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
6. Create the immutable `v0.1.1` tag and publish matching artifacts by digest and
   the matching versioned documentation from that verified commit.
7. Verify `/api/health/build-info`, image metadata, and the 0.1 Stable docs selector.

See [Development](index.md), [Compatibility](../reference/compatibility.md), and
[Release channels](../releases/channels.md).
