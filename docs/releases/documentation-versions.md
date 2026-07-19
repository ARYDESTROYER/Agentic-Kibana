---
title: Documentation versions
description: How TLSOC documentation versions map to application releases and the Testing-to-Stable promotion flow.
---

# Documentation versions

TLSOC publishes documentation by product release line. The selector on the site is the
authority for the version currently being read.

## Version mapping

| Documentation label | Application SemVer | Source identity | Channel |
|---|---|---|---|
| 0.1 review artifact | 0.1.0 | accepted candidate commit on `Testing` | Testing |
| 0.1 published site | 0.1.0 | `main` commit tagged `v0.1.0` | Stable |

The shorter documentation label keeps patch-compatible guidance together. When a patch
changes behavior or an operational procedure, the 0.1 documentation is rebuilt from the
accepted patch and its release notes describe the change. A future incompatible or
feature release receives a new documentation line rather than rewriting 0.1 silently.

## Publishing model

```text
feature branches → Testing → main (Stable)
```

- Pull requests and `Testing` changes must pass a strict documentation build.
- `Testing` output is a review artifact, not the public Stable site.
- An accepted promotion to `main` publishes the versioned documentation.
- After the first Stable publication, the `stable` and `latest` aliases point to
  the current supported documentation line.
- Previously published version directories remain available for old deployments.

The initial Stable publication creates `/0.1/`; `/stable/`, `/latest/`, and the site
root then resolve to that supported line. Link to `/0.1/` when a procedure must remain
fixed to that release, and use `/stable/` when following the supported release is
intended.

## Repository publication prerequisites

Before the first Stable publish, repository administrators must:

1. create and protect `Testing` and `main`, make `main` the default branch, and
   require the documented pull-request and CI gates on both;
2. allow the documentation workflow to write repository contents;
3. promote the accepted 0.1 source tree to `main` and let the workflow create the
   `gh-pages` branch, version directory, aliases, and root redirect;
4. configure GitHub Pages to deploy from the `gh-pages` branch at `/`.

The generated `gh-pages` branch is publication output. Do not edit it by hand; edit
the matching Markdown on `Testing`, promote through `main`, and let Mike republish it.

## Version selector behavior

Changing the selector attempts to preserve the current page path in the selected
version. When that page did not exist, the destination may fall back to the selected
version's root. Always confirm the version label after following an external link or a
search-engine result.

Older documentation displays an outdated-version warning. It remains useful for
operating an old deployment, but security guidance may have been superseded. Compare
the current Stable security and release notes before making a risk decision.

## Source and edit policy

Stable documentation corresponds to accepted source on `main`; `Testing` contains the
next integrated documentation changes. An edit proposed from an older rendered version
must target the correct source history or intentionally update the current Stable page.
Do not assume the old rendered page can be reconstructed from today's Markdown alone.

## Documentation compatibility

Use documentation that matches `/api/health/build-info.version`. If the reported
version contains uncommitted/custom build metadata, use the closest documented base
version and also consult the deployment's own change record.

See [TLSOC 0.1](0.1.md) and [Upgrades and promotion](../operations/upgrades.md).
