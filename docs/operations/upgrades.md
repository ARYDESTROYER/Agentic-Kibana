---
title: Upgrades and promotion
description: Promote TLSOC from Testing to Stable/main and upgrade versioned deployments safely.
---

# Upgrades and promotion

TLSOC uses two permanent release branches:

```text
feature branches → Testing → main (Stable)
```

`Testing` is the integration and acceptance branch. `main` is the supported Stable
branch. Version 0.1 is represented as `0.1.0` in packages/images and `v0.1.0` as an
immutable release tag; its documentation line is `0.1`.

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

Stable hotfixes branch from `main`, return to `main` through review, receive a new patch
tag, and are merged back into `Testing` so the fix is not lost.

See [Version 0.1](../releases/0.1.md),
[Documentation versions](../releases/documentation-versions.md), and
[Health, backup, and restore](health-backup.md).
