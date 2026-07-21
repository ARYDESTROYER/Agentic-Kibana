---
title: Documentation versions
description: How installed, Stable, and Development documentation relate to Agentic SOC application releases.
---

# Documentation versions

Agentic SOC ships version-matched documentation with the application. The documentation
served by the running app is the authority for its controls and behavior; the public
Stable site and Development source are secondary destinations for upgrade planning
and previewing future work.

## Which documentation should I use?

| Destination | What it represents | Use it for |
| --- | --- | --- |
| **Installed version** | The Help Center built from the same accepted source as the running application and served on that application origin at `/docs/0.1/` | Daily use, administration, troubleshooting, and every decision about the running build |
| **Latest Stable** | Documentation built from the current protected `main` release and its immutable tag | Upgrade evaluation, current supported guidance, and comparison with an older installation |
| **Development** | Documentation source integrated on `Testing` but not yet promoted and tagged | Preview and review only; never assume it describes the installed application |

Open **Documentation** from the bottom of the application navigation to enter the
installed Help Center. GitHub remains the source/edit location and an escape hatch
for newer material; it is not the primary product-help destination.

## Installed documentation contract

Every application build carries two related identifiers:

- the full product SemVer, such as **0.1.0**; and
- the compatible documentation line, such as **0.1**.

The documentation build and the application build originate from the same source
commit. The web image includes the generated static Help Center and serves it from
the same origin as the Console. That provides four useful guarantees:

1. documentation remains available in an offline or isolated self-hosted deployment;
2. following an in-app documentation link does not leave the application by default;
3. the installed guide cannot silently change underneath a pinned application image;
4. a release artifact and its instructions can be traced to the same source identity.

The installed Help Center does **not** show a blanket “may be outdated” warning. It
is intentionally accurate for that installed build. A notice is appropriate only
when the reader chooses an older public documentation version or follows a link to
newer Stable or Development material.

## Version mapping

| Documentation label | Application SemVer | Source identity | Channel |
| --- | --- | --- | --- |
| 0.1 installed Testing guide | 0.1.0 | candidate commit on `Testing` | Testing |
| 0.1 installed Stable guide | 0.1.0 | verified `main` commit tagged `v0.1.0` | Stable |
| 0.1 public Stable guide | 0.1.0 | the same verified tag used by the Stable artifacts | Stable |

The shorter documentation label keeps patch-compatible guidance together. When a
patch changes behavior or an operational procedure, the 0.1 Help Center is rebuilt
from that accepted patch and its release notes describe the change. A future
incompatible or feature release receives a new documentation line rather than
rewriting 0.1 silently.

The channel is independent of SemVer. A Testing candidate and a Stable artifact may
both report application version `0.1.0`; only the accepted `main`/tag provenance may
claim Stable.

## Confirm what is installed

Use either of these sources:

1. open the top-right release badge in the Console; or
2. read `/api/health/build-info` from the same deployment.

Compare the reported application version and channel with the version context shown
in the Help Center. If the Console and backend stamps disagree, the Console fails
safe to Testing. Resolve that packaging mismatch before treating either component as
a Stable release.

If a custom build contains uncommitted or local build metadata, use its bundled Help
Center first and retain the deployment's own change record. Public documentation can
describe only the closest accepted base release.

## Public Stable and Development material

The versioned public site complements the installed Help Center:

```text
feature branches → Testing documentation review → main/tag Stable publication
```

- Pull requests and `Testing` changes must pass a strict documentation build.
- `Testing` output is a review artifact, not supported Stable guidance.
- An accepted promotion to `main` publishes the versioned Stable documentation.
- The `stable` and `latest` aliases point to the current supported documentation
  line after its release.
- Previously published version directories remain available for older deployments.

The initial Stable publication creates `/0.1/`; `/stable/`, `/latest/`, and the
public-site root then resolve to that supported line. A public version selector
attempts to preserve the current page in the selected release line and falls back to
that line's home page when the article did not exist.

Older public documentation displays an outdated-version warning. It remains useful
for operating an older deployment, but later security or upgrade guidance may have
superseded it. That warning concerns the selected public version; it does not make
the documentation bundled with an older installed app inaccurate for that app.

## Repository publication prerequisites

Before the first Stable publish, repository administrators must:

1. create and protect `Testing` and `main`, make `main` the default branch, and
   require the documented pull-request and CI gates on both;
2. allow the documentation workflow to write publication output;
3. promote the accepted 0.1 source tree to `main` and let the workflow create the
   version directory, aliases, and root redirect; and
4. configure the public documentation host for that generated output.

The current remote has `Testing` and legacy/default `claude/main`, but no literal
`main`. These prerequisites are therefore still outstanding and the public Stable
publication contract has not yet been activated. Never treat `claude/main` as
Stable implicitly.

Generated public-site output is a release artifact. Do not edit it by hand; edit the
Markdown on `Testing`, promote the accepted source through `main`, and let the
documentation workflow republish it.

## Source and edit policy

The application-hosted Help Center is the reading surface. The repository is the
authoring surface:

- Stable documentation corresponds to accepted source on `main` and an immutable
  release tag.
- `Testing` contains the next integrated documentation changes.
- An edit proposed from an older rendered version must target the appropriate source
  history or intentionally update the current release line.

Do not replace an installed Help Center link with a raw repository link merely
because both contain the same Markdown. The local rendered article is version-matched,
searchable, themed, and available with the application; “View source” and “Edit this
page” are secondary contributor actions.

See [Agentic SOC 0.1](0.1.md), [Release channels and versioning](channels.md), and
[Upgrades](../operations/upgrades.md).
