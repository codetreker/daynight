---
name: release-daynight
description: Select and bump packages/daynight's version, deliver its release PR, publish through the existing workflow, and verify npm results when a CLI release or version bump is requested.
---

# Release Daynight

Release `@codetreker/daynight` from this repository. Follow the session's actual
authorization for PRs, merging and publication; this skill grants none. Ordinary
change PRs leave the package version unchanged. Use one release task and worktree
under the [repository instructions](../../../AGENTS.md).

Read the [publication guide](../../../docs/development.md#npm-publication) for
the existing workflow, OIDC, artifacts, lookup errors and partial-publication
behavior. Reuse those mechanisms.

## Establish the published source

Refresh `origin/main` and query public npm metadata:

```bash
npm view @codetreker/daynight@latest --json --registry=https://registry.npmjs.org --cache .tmp/npm-cache
```

Validate the package identity, stable version and full `gitHead`. If the remote
`daynight-v<version>` tag exists, require it to identify the same source commit.
A missing tag does not erase a publication with a verifiable npm `gitHead`.
Fetch the required history and require that source to be an ancestor of the
candidate mainline source. Lookup failures, conflicting identities or unrelated
history stop version changes; do not infer a baseline from the working manifest
or the nearest local tag. With no verifiable previous publication, obtain an
explicit initial version and source decision before preparing a first release.

Review commits and actual differences from that published source to the current
candidate. Count changes to CLI behavior, bundled skills, the usage manual, SQL
resources, shipped dependencies and build inputs by their actual CLI impact.
Independent Web/server changes, repository workflow skills and test-only changes
do not establish a new CLI capability. Inspect shared dependency/build changes
for their effect on the CLI. Commit prefixes are clues, not version decisions.

## Choose the version

Use the highest applicable change category:

| CLI change | Automatic increment |
|---|---|
| Fix, performance improvement, internal refactor, compatible dependency update, or resource correction without a new capability | patch |
| New user capability or public usage | minor |
| Incompatible change while the published major version is `0` | minor, with impact and migration guidance |

No CLI release change means no automatic release. An explicit request to release
the same implementation still needs a new legal version. Never automatically
cross a major boundary, including `0.x` to `1.0.0`; an incompatible change after
`1.0.0` requires an explicit major-version decision.

Calculate the patch/minor increment from npm `latest`, then take the greater of
that result and main's current stable manifest version. Reuse a sufficient
unpublished version; never lower it. For published `0.37.2` and main `0.37.7`,
fixes use `0.37.7`, while new capabilities use `0.38.0`. If the manifest would
make this cross a major boundary, require an explicit version decision.

An explicit target overrides the automatic recommendation, but must be stable
`x.y.z`, greater than npm `latest`, and at least main's current version. Check
both the exact npm version and `daynight-v<target>` tag before committing to a
new release. Existing markers require reconciliation against the intended source,
not an assumption that the target is free or this release is complete.

Record the published baseline, selected version and substantive CLI changes in
the release task. Include incompatible behavior and migration needs.

## Deliver and publish

When a version change is needed, update `packages/daynight/package.json` in the
release worktree and deliver a focused PR. A version-only edit does not require
lockfile churn. Apply repository validation and independent review, wait for the
required current-head checks and approval, resolve blocking threads, and squash
merge bound to the verified head. Reuse an already suitable version on main
without an empty PR. Keep the existing branch protections intact.

Before publication, refresh main, npm `latest`, exact target markers and active
publication runs. Reassess the version if another change or release has altered
the candidate. Reconcile any existing run for this release before dispatching:

```bash
gh workflow run publish.yml --ref main
```

Identify that dispatch's actual run ID, source `headSha` and manifest version;
do not assume the newest run belongs to it. Track the run through preparation,
publication and verification. If the dispatched source differs from the checked
candidate, reassess its CLI changes and version and report the discrepancy;
do not claim that a different source was released. The workflow's own CLI
validation owns publication admission; no extra wait for unrelated mainline CI
is needed.

## Verify or recover the same release

Completion requires the intended stable version at public npm `latest`, exact
npm metadata with the intended `gitHead`, and `daynight-v<version>` pointing to
the same source. Download the producing preparation run's retained
`npm-publication` artifact, locating the original run when a retry skipped, and
check its `release.json`, SHA-512 integrity and public tarball bytes agree. Install the
exact public npm version in an isolated `.tmp/` consumer, then check its
`daynight --version` and `--help`. Keep npm caches and all temporary resources
inside the release worktree's `.tmp/` and clean them up afterward.

A successful existing-version skip verifies none of those facts. After a lost
response, failed upload, verification failure or missing tag, read the actual PR,
run, npm and tag state before another mutation. Resume and verify that same
release; never bump again merely to hide an uncertain result. An accepted npm
package without its verified tag remains incomplete. The existing publisher
skips occupied versions and does not repair missing tags: report the exact
missing evidence or required recovery, preserving errors and immutable markers.

Save the version, release PR if any, source SHA, run URL, npm metadata/integrity,
tag and installation result in the release task. Mark it complete only when
those observations agree; report concrete failures and partial results honestly.
