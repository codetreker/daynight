# Agent Note: Version-Only PR Validation

Status: implemented

## Problem

A CLI release can change only the package version after its application changes
have already passed their own checks. The module selector still runs three
platform suites, four Node compatibility jobs and shell completion for that
metadata change. Those suites repeat application validation while the version
change directly affects the manifest and the installed package's reported
version. Skipping every check would leave that artifact behavior unverified.

## Decision

The [selector](../../../../.github/scripts/ci-modules.mts) recognizes a complete
version-only PR from the committed merge-base and explicit head. Its entire diff
must contain exactly one modified path: `packages/daynight/package.json`. Both
sides must retain the same regular-file mode. Parsed manifests must have string
versions that differ, with every other field deeply equal. JSON whitespace and
object key order do not affect that proof; nested fields and array order remain
significant. Additional paths, including documentation exclusions, formatting
alone, mode changes, additions, deletions and type changes retain ordinary
selection. Invalid modified manifests and Git read failures fail detection.

The [checks workflow](../../../../.github/workflows/checks.yml) selects one
Ubuntu/Node.js 24 release job for that case, replacing the ordinary CLI matrices
and leaving Go and Web unselected. It builds the CLI and reuses the publication
preparation command to validate existing stable-version syntax and produce a
source-bound tarball. An isolated consumer installs the tarball; both `daynight`
and `dn` must report the manifest version and execute `--help` successfully.
The final required `checks` job includes the release job and rejects failure or
cancellation. Main pushes retain complete application validation.

This partially supersedes the [server input-selection decision](2026-11-04-server-ci-input-selection.md),
which omitted server work for semantic manifest equality but retained the full
CLI suite. Ordinary CLI routing and every selected job's acceptance criteria
remain intact. The manual publication workflow independently validates the
frozen release source and artifact; the PR job performs no registry lookup or
publication and does not replace those checks.

## Alternatives

**Keep the full CLI matrix for version-only PRs.** The module-level selector
already provides conservative validation. It also reruns application tests
across platforms and Node versions without changes to their inputs beyond the
reported version; publication independently repeats CLI validation.

**Check only manifest syntax.** This avoids a build and package installation,
but cannot show that the packed CLI contains its manifest or that both installed
command aliases expose the intended version and remain runnable. The single
build-and-install smoke check verifies the behavior that changes.

## Consequences

Strict version-only PRs run one application validation job instead of eight.
Routing and the final required gate still run. Dependency installation, building
and packing remain necessary, so the change does not promise a fixed elapsed
time. Mixed changes and main pushes retain their existing workloads.

The exception depends on whole-PR evidence rather than a path exclusion. New
manifest fields automatically participate in semantic comparison, and the
existing dependency-free detector needs no registry access or imported package
to establish the exception. Publication mechanics and their validation remain
owned by the existing release workflow.
