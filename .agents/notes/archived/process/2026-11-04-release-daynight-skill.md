# Agent Note: Repository CLI Release Skill

Status: implemented

## Problem

An unpublished package version can advance through several code changes before
the next npm release. Incrementing that version independently in feature PRs
does not identify the release's compatibility level or prove that its source
and artifact reached npm. Publication also has an existence-only skip: a green
retry can leave an accepted package without a verified tag.

## Decision

The repository's [release-daynight skill](../../../skills/release-daynight/SKILL.md)
owns CLI version selection and complete release delivery. Ordinary change PRs
leave `packages/daynight/package.json`'s version unchanged. The skill compares
the public npm `latest` source with the proposed mainline source, classifies
actual CLI behavior, and selects patch or minor while accepting explicit stable
versions. An already sufficient unpublished manifest version is retained.
Incompatible `0.x` changes require minor and migration guidance; a major boundary
requires an explicit decision.

This gives the [release-time versioning decision](../simplification/2026-11-04-release-time-versioning.md)
a single repository workflow owner without restoring its removed per-change
version comparison.

The [development guide](../../../../docs/development.md#npm-publication) remains
the owner of publication mechanics. The skill uses the existing protected PR
path and manual main-only workflow. It requires the public package, retained
artifact and immutable tag to agree on the source, then checks installation of
the public package. Session authorization continues to govern external actions.

The [publication-check decision](2026-10-22-npm-cli-publication-checks.md) still
owns lookup, duplicate-publication and existence-only skip behavior. End-to-end
release verification does not change those skip rules or add tag-repair
infrastructure. A partial publication remains an explicit incomplete result.
The [CLI validation decision](2026-10-22-cli-publication-validation.md) continues
to own the workflow's CLI-only release admission.

## Alternatives

**Increment every feature PR.** This consumes versions before publication and
makes the eventual version depend on PR count without establishing the release's
actual compatibility level.

**Default every release to patch.** This gives a deterministic number but can
label added capabilities or incompatible `0.x` changes as fixes. The published
source comparison provides the actual release scope.

**Stop at a version edit or successful workflow.** This omits the public package
and source checks, and mistakes an existence-only skip for verified delivery.

## Consequences

Version changes are concentrated in release preparation. The skill stays small
and delegates publication mechanics to the maintained workflow and guide, while
compatibility classification remains a semantic judgment over actual CLI changes.

An already prepared version is reused when it satisfies that judgment, including
release resumption. Registry/history failures and conflicting source identities
remain visible. Existing npm versions and tags stay immutable, and the skill
cannot claim complete delivery when publication succeeded only partially.
