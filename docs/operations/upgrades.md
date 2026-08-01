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
branch. Version 0.1 is represented as `0.1.1` in packages/images and `v0.1.1` as an
immutable release tag; its documentation line is `0.1`.

!!! note "Canonical topology and administrative controls"

    The remote now uses `Testing` for integration and default `main` for accepted
    Stable source, and it has the `v0.1.1` release tag. Pull-request protections,
    required checks, and release-environment policy are repository settings rather
    than source-code guarantees. Administrators must verify them independently;
    branch and tag names alone do not prove acceptance.

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

Promote through a reviewed pull request. Tag the accepted `main` commit `v0.1.1` and
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
`0.1.1` from Testing to Stable changes provenance, not its SemVer.

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

## Activate an already-deployed Console release

The top-bar **Update available** control is an activation aid, not a deployment
mechanism. It appears only when the browser can prove that a different static Console
release has already been deployed and is paired with its ready backend:

1. the same-origin, no-store `/release.json` describes a different Console build;
2. its version, channel, non-`unknown` commit SHA, and non-`unknown` build time
   exactly match `/api/health/build-info`; and
3. `/api/health` reports `status: ok` for that same version.

Release automation must stamp the Web and backend artifacts with the same immutable
SHA and build time. Development/Compose defaults that report either value as `unknown`
remain fully usable but deliberately never expose the activation control.

An absent, malformed, stale, unreachable, or internally inconsistent response does
not interrupt the running Console and does not produce an update offer. The browser
never guesses from a mutable tag, SemVer alone, or the repository branch name.

Activation is always explicit. Selecting **Update available** opens a confirmation
that explains the full-page reload. If the Console knows about an unsaved draft, it
withholds the dialog's confirm action until the operator saves or discards that work;
the native page-exit guard remains a second line of defence. There is no automatic
reload.

Immediately before navigation, the Console repeats the no-store manifest, backend
build-info, and health checks, confirms that they still identify the offered target,
and verifies that same-origin `/index.html` is valid HTML with the expected app root
and the manifest's release-entry marker. Only then does it replace the current
document while preserving the current hash route. A changed target, network failure,
unhealthy backend, identity mismatch, or invalid entry document leaves the current
Console untouched. The operator may retry after the deployment is coherent.

This control deliberately cannot pull images, restart containers, run migrations,
hold deployment credentials, promote a channel, or select/execute rollback. Those
remain external, reviewed deployment operations governed by the procedure above.
Reloading the browser does not cancel backend jobs already accepted by the server.

## Observe upstream source revisions

Open **Settings → Organization → Updates & releases** to configure the public
GitHub repository and the branch used for each release channel. Fresh installations
observe:

```text
Repository: https://github.com/ARYDESTROYER/Agentic-Kibana
Stable branch: main
Testing branch: Testing
Check interval: 360 minutes
```

The backend checks public GitHub metadata through a fixed, bounded, read-only path.
It reads the branch head and root `VERSION`, caches the result for the configured
interval, and exposes the observation to authenticated operators. It does not clone,
pull, execute, build, deploy, restart, migrate, promote, or roll back anything. The
browser never contacts GitHub directly. Operators can use **Check now** after saving
changed repository or branch settings; the manual endpoint has its own short cooldown.

A newer observed SemVer, or a different SHA on the same current version, may produce
an amber **Source available** notice beside the version badge. The notice links to the
immutable public commit and explicitly means “source exists upstream,” not “this
deployment can update.” Older versions are never offered as upgrades. Network/rate-limit
failures do not interrupt the Console; a last verified observation may remain visible
as stale.

The blue **Update available** action remains governed only by the already-deployed,
same-origin manifest/readiness contract above. Source discovery can never make that
control appear by itself. The default Stable observation now targets canonical
`main`; it remains read-only source metadata and cannot prove repository protection,
release acceptance, or the availability of an already-deployed update.

!!! important "Static-asset retention is part of a graceful rollout"

    An open tab may still request an old lazy-loaded hashed asset before the operator
    activates the new release. Keep the previous web artifact's hashed assets
    available for the complete observation window, or use a blue-green deployment
    that keeps the old origin reachable until sessions drain. Replacing the static
    web root and immediately deleting old chunks is not a graceful rollout, even when
    the activation preflight is correct.

Release observation and activation remain independent of the strict plain-text
authoring contract for Intelligence → Runbooks; see
[Runbooks](../intelligence/runbooks.md).

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
