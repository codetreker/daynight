# Agent Note: Bounded Main CI Runs

Status: implemented

## Problem

Independent main CI runs compete for finite runner capacity. A burst of merges
can leave a backlog of obsolete validations waiting alongside the latest revision.

## Decision

The `checks` and `shell and browser acceptance` workflows each group runs by
workflow and ref. Main runs do not cancel the running run, and GitHub's default
single pending slot allows a newer run to replace an older waiting run. Manual
shell/browser dispatches on main share the same group as main pushes. PR runs
retain cancellation for the same ref; workflows and different refs remain
isolated. Trigger selection and the final checks gate remain unchanged.

This replaces the [independent main runs decision](2026-11-18-independent-main-ci-runs.md),
which sought validation for every integrated revision and accepted runner
competition to avoid replacing pending runs.

## Alternatives

**Keep independent main groups.** Every trigger can run, but bursts accumulate
waiting work and compete for runner capacity.

**Use `queue: max`.** A larger bounded queue preserves more pending runs but
retains a backlog rather than selecting the latest waiting revision.

## Consequences

The running main validation survives later triggers and at most one run waits per
workflow group. Intermediate commits may receive no main validation if their
pending runs are replaced. The configuration relies on
[GitHub's concurrency semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency);
local configuration tests cannot demonstrate actual scheduler behavior.
