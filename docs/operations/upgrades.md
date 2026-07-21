---
title: Upgrades and promotion
description: Promote Agentic SOC from Testing to Stable/main and upgrade versioned deployments safely.
---

# Upgrades and promotion

Agentic SOC's intended release contract uses two permanent branches:

```text
feature branches → Testing → main (Stable)
```

`Testing` is the integration and acceptance branch. `main` is the supported Stable
branch. Version 0.1 is represented as `0.1.0` in packages/images and `v0.1.0` as an
immutable release tag; its documentation line is `0.1`.

!!! warning "Provision Stable before the first promotion"

    The current remote exposes `Testing` and legacy/default `claude/main`, not a
    literal `main`. A repository owner must create or rename and protect `main`,
    make it the default, and require the release gates before the first promotion.
    Alternatively, retaining `claude/main` requires a deliberate, consistent change
    to all workflows and documentation. Until that work is complete, there is no
    Stable branch or tag to upgrade from.

    Do not push `Testing` over `claude/main`. Preserve the legacy tip, bootstrap and
    protect literal `main`, promote through a pull request, verify/tag it, and only
    then retire `claude/main`; the exact one-time sequence is in
    [Release channels](../releases/channels.md#one-time-cleanup-of-the-legacy-claudemain-branch).

## Promotion gate

Before promoting `Testing` to `main`:

- review the complete diff and release notes;
- pass backend, web, generated-contract, version-consistency, Compose, and documentation
  gates;
- exercise clean install, restart, source ingest, investigation, authentication, and
  notification smoke tests;
- back up and restore the reference state backend;
- record known limitations and rollback criteria;
- ensure every package, image, OpenAPI document, and documentation page uses the same
  release identity.

Promote through a reviewed pull request. Tag the accepted `main` commit `v0.1.0` and
publish artifacts identified by digest. Do not move a release tag.

### Version and promotion checklist

1. Update the root `VERSION` once; synchronize backend/package metadata, web
   package and lockfile, OpenAPI, Compose build defaults, Docker labels, MkDocs,
   release notes, and the matching documentation line. Keep one active
   `[Unreleased]` section during development; the final frozen preparation moves its
   accepted entries under `[X.Y.Z]`, opens a fresh `[Unreleased]`, and then promotes
   that exact prepared tree without drift.
2. Run `python3 scripts/check_version.py` and `python3 scripts/check_docs.py`.
3. Run the complete backend suite and the Console typecheck, lint, design gates,
   test, and production build.
4. Regenerate and verify OpenAPI/TypeScript contracts; validate both Compose files;
   build the strict docs site.
5. Build the candidate with `TLSOC_RELEASE_CHANNEL=testing` plus its exact
   `TLSOC_BUILD_SHA` and `TLSOC_BUILD_DATE`. Confirm the OCI source URL (the
   Dockerfile defaults to this repository; forks must override the build argument),
   then record digests and `/api/health/build-info`.
6. Freeze and accept that Testing source tree. Promote it without content changes
   through the protected PR, then rerun the full gate on the resulting `main` SHA.
7. Build that verified SHA with `TLSOC_RELEASE_CHANNEL=stable`, tag it exactly once,
   publish by digest, and let the docs workflow move `stable`/`latest`.

`TLSOC_VERSION` and `TLSOC_RELEASE_CHANNEL` answer different questions. Promoting
`0.1.0` from Testing to Stable changes provenance, not its SemVer.

## Deployment upgrade procedure

1. Read the release notes and limitations for both versions.
2. Capture `/api/health/build-info` and image digests.
3. Stop or quiesce ingestion as required by the state backend.
4. Create and verify a state backup plus a separate secret/config backup.
5. Pull/build the exact accepted release artifacts.
6. Apply explicitly documented configuration changes.
7. Start state dependencies, backend, then web UI.
8. Require readiness before traffic.
9. Validate login, sources/cursors, a synthetic case, cost ledger, and notifications.
10. Retain the old artifacts and backup until the observation window closes.

## Rollback

Rollback is not merely starting an older image. A newer version may have written state
that older code does not understand. Version 0.1 does not provide a complete schema
migration/rollback framework, so restore the pre-upgrade state backup when release notes
do not explicitly guarantee backward compatibility.

Stable fixes start on a focused branch from the affected source, merge into
`Testing`, pass the same acceptance gate, and promote forward to `main` as a patch
release. Emergency timing may shorten review, but it must not reverse the permanent
Testing-to-Stable direction or patch only `main`.

See [Version 0.1](../releases/0.1.md),
[Documentation versions](../releases/documentation-versions.md), and
[Health, backup, and restore](health-backup.md).
