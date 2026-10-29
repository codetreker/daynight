# Agent Note: Remove the target acceptance mechanism

Status: implemented

## Problem

The target execution, package handoff and completion-proof mechanism increased
acceptance infrastructure without delivering the requested CI speed outcome.
Its removal must restore the prior checks without deleting existing production
browser coverage or rewriting merged history.

## Decision

Revert [PR #293](https://github.com/codetreker/daynight/pull/293), commit
`d61dde61b6f90169b404d5d4b285b4b1960e131c`, restoring code, configuration and active
documentation to its parent. Discard the unpublished parallel-CI draft. The
independent capacity fixture change from PR #291 remains.

The original complete acceptance entry, schema 3 evidence/recovery, shared local
CLI installation, 63 browser scenarios, authentication journeys, performance
budgets and cleanup checks remain. Target-selection arguments, prebuilt-package
handoff and completion-file/hash validation are removed. The [original decision](../../archived/testing/2026-10-28-web-target-acceptance.md)
is retained only as immutable history.

## Alternatives

**Retain a subset of the new mechanism.** This would preserve infrastructure
that the requested complete removal explicitly withdraws.

**Continue parallel-CI delivery.** That delivery is withdrawn together with its
unpublished draft; it is not an implicit follow-up to this revert.

## Consequences

Acceptance returns to the previous complete-run contract. This removal makes no
new CI speed claim and introduces no compatibility path for intermediate
schema 4 temporary receipts. The merged PR remains in Git history, followed by
an ordinary revert commit.
