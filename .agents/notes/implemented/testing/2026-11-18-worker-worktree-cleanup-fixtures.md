# Agent Note: Worker Worktree Cleanup Fixtures

Status: implemented

## Problem

Several terminal cleanup cases create a full Worker worktree from a bare
origin before observing removal, cancellation, or error classification. The
repeated remote and branch preparation does not establish those guarantees.
The [scan fixture](2026-11-18-worker-worktree-scan-fixtures.md) already creates
equivalent native registration state for cases that start after preparation.

## Decision

The [Worktree tests](../../../../packages/daynight/test/commands/worker/worktrees.test.ts)
share a fixture operation that uses native Git to register the checkout and
the real store to publish its manifest. Selected terminal cases prepare the
private repository with their existing manager and then use that operation.
The associated Git, filesystem, policy, cancellation and ownership faults
remain at their original points. Cases with two managers retain separately
constructed instances so their gate and fresh observation assertions are real.
The successor discovery cases also start with this registered checkout; the
verified successor still uses production preparation, while the unrelated
checkout is registered by Git outside the managed namespace. Both retain real
removal and registration checks.

## Alternatives

**Use a shared mutable checkout or fabricate its pointers.** Cleanup tests
mutate native registration, manifests, and directories. Each case must own
that state, and Git must create the normal metadata it later reads or removes.

**Replace full preparation everywhere.** The actual fetch deadline, new-claim
and recovery cases exercise that workflow. Their original setup and assertions
remain in place. The native sudo cases initially kept full preparation. The
[native sudo fixture decision](2026-11-23-native-sudo-worktree-setup.md) extends the
registered-checkout fixture to the existing-state permission and pointer cases.

## Consequences

The selected cases skip the remote and fetch workflow without changing
test selection, process budgets, or production operations. The worktree scan
and cleanup tests share only the native fixture setup, not mutable state.
