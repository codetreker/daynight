# Agent Note: Version-Only PR CI Selection

Status: implemented

## Problem

A CLI release can change only the package version after its application changes
have already passed their own checks. At adoption, the module selector still ran
three platform suites, four Node compatibility jobs and shell completion for that
metadata change. Those suites repeated application validation, while the
publication workflow already validated the frozen release source and installed
artifact.

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

A proven version-only PR selects no application jobs. The existing routing
checks and final required `checks` gate still run, and the gate continues to
reject failed or cancelled checks. Main pushes retain complete application
validation. Version validity, packaging and installed artifact validation remain
in the existing manual publication workflow; no PR validation job is added.

This partially supersedes the [server input-selection decision](2026-11-04-server-ci-input-selection.md),
which omitted server work for semantic manifest equality but retained the full
CLI suite. Ordinary CLI routing and every selected job's acceptance criteria
remain intact.

## Alternatives

**Keep the full CLI matrix for version-only PRs.** The module-level selector
already provides conservative validation. It also reruns application tests
across platforms and Node versions without changes to their inputs beyond the
reported version; publication independently repeats CLI validation.

**Add a separate release build-and-install job.** A dedicated job can verify
the new package version before merge, but adds dependency installation, building
and packing for metadata-only PRs. The existing publication workflow already
owns version and artifact validation at the actual frozen release source.

## Consequences

Strict version-only PRs skip application verification jobs and retain only
routing and final aggregation. Mixed changes and main pushes retain their
ordinary selected workloads. The
[local shell acceptance decision](2026-11-06-local-shell-completion-acceptance.md)
owns the removal of the independent shell-completion job from those workloads.
A version rejected by publication validation remains a publication failure; this exception adds no earlier version-admission policy.

The exception depends on whole-PR evidence rather than a path exclusion. New
manifest fields automatically participate in semantic comparison, and the
existing dependency-free detector needs no registry access or imported package
to establish the exception. Publication mechanics and their validation remain
owned by the existing release workflow.
