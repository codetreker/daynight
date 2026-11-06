# Agent Note: CLI Publication Validation

Status: implemented

## Problem

An npm release of `@codetreker/daynight` can be blocked by an unrelated Go server
or Web failure when publication requires the entire mainline checks workflow to
succeed. The [publication preparation job](https://github.com/codetreker/daynight/actions/runs/39715731529/job/119617343974)
spent six minutes waiting for the full mainline run and stopped on a Go server
failure even though all three native CLI jobs had passed. Publication needs
validation of the exact CLI source and package it delivers.

## Decision

The [manual publication workflow](../../../../.github/workflows/publish.yml)
validates the CLI independently at its frozen `GITHUB_SHA`. Preparation performs
a frozen dependency install, then explicitly filters type checking, tests and
installed acceptance to `@codetreker/daynight`. It packs that source and
smoke-installs the exact tarball retained for publication. CLI validation or
package installation failures still stop the release.

Preparation no longer queries or waits for `checks.yml`, and needs only the
workflow's read-only contents permission. Main-push checks still validate every
module independently of publication. No application suites or repository
protection settings change.

This replaces the full-main prerequisite in the
[trusted-publishing decision](2026-10-20-npm-trusted-publishing.md). That
prerequisite provided broad integration evidence when release validation was
established, but coupled the CLI's release to independently delivered modules.
The [module-scoped CI decision](2026-10-21-module-scoped-pr-ci.md) and
[CI gate simplification](../simplification/2026-10-21-ci-gate-simplification.md)
retain their mainline scheduling and aggregation rules. Main-only dispatch,
existence preflight, OIDC, source-bound artifacts, public byte verification and
immutable tagging retain their existing owners and behavior.

## Alternatives

**Wait only for CLI jobs in the mainline checks run.** This would avoid Go and
Web blockers but still require discovering an external run and interpreting its
individual jobs. Preparation already validates the exact CLI source and installed
package, so that dependency repeats validation and adds release coordination.

**Keep the full-main prerequisite.** This provides cross-module evidence before
publication, but a server or Web failure still prevents releasing a validated
CLI package, as the observed publication failure demonstrates.

## Consequences

A new npm release waits for its own CLI checks and package verification. Missing,
running or failed mainline checks do not gate publication. The release does not
claim successful server, Web, shell-completion or cross-platform acceptance;
those results remain owned by their regular CI jobs. Retaining that separation
allows their validation to evolve without changing the npm release gate.
