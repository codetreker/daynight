# Agent Note: Release-Time Package Versioning

Status: implemented

## Problem

Requiring a package version increase for every CLI source or build-input change
couples ordinary integration to release numbering. Independent changes must each
select a version even when they will be published together, and concurrent PRs
can select the same version and invalidate one another's comparison.

## Decision

Package versions are selected during release preparation through the
[release-daynight skill](../../../skills/release-daynight/SKILL.md). Ordinary
change PRs leave the package version unchanged; the
[release workflow decision](../process/2026-11-04-release-daynight-skill.md) owns
version classification and complete release verification. PR and main validation
run without comparing package versions between Git revisions. The dedicated
version-increase workflow step, local command, checker and checker tests are
removed. Module routing and application validation retain their existing rules.

The manual publication workflow continues to require stable SemVer, skip exact
versions already represented by a Git tag or npm package, and reject a new
publication that would not advance npm `latest`. Source-bound tarballs, registry
byte verification and immutable tags retain their publication guarantees.

This replaces the per-change version rule in the archived
[toolchain decision](../../archived/process/2026-10-16-typescript-cli-toolchain.md)
and the version-check timing in the archived
[CI simplification decision](../../archived/simplification/2026-10-21-ci-gate-simplification.md).
The earlier rule made release-input changes explicit, and its later PR-only
placement avoided rejecting a main push after the same comparison had passed
before merge. The final job-result aggregate from that decision remains in use.

## Alternatives

**Remove only the CI invocation.** Retaining the local checker would leave a
command whose enforced per-change policy conflicts with release-time version
selection. Removing its dedicated implementation and documentation gives local
development and hosted validation the same policy.

## Consequences

Multiple code changes can share a package version until a release is prepared.
Release preparation must choose a new version for publishing new bytes; leaving
an already published version in the manifest causes a successful publication
skip. Ordinary CI no longer establishes version precedence against the target
branch. Publication remains the owner of release admission and artifact identity.
