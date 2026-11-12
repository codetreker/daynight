# Agent Note: Reconcile worktree cleanup against fresh resource state

Status: implemented

## Problem

A cleanup effect can report an error after removing its target. Treating the
error as proof that resources remain prevents retirement, while reusing an
expired operation for verification cannot establish their actual state.

## Decision

The Git manager joins admitted mutations and observes the original directory
and registration under a fresh five-minute budget, separately from the effect
budget. Both inherit the outer cancellation signal; cancellation prevents a new
observation. Confirmed absence returns the original effect errors to consumers,
which report them before continuing backend and manifest retirement. Remaining
resources retain the effect error, and failed observation preserves both errors.
The [Worker design](../../../../docs/design/daynight-worker.md#结束清理与退出) owns the
current cleanup sequence.

## Alternatives

**Treat every effect error as failure.** This leaves a completed deletion and
its associated cleanup responsibility pending until another attempt.

**Ignore the error or reuse the effect deadline.** Ignoring it loses diagnostic
evidence; an expired deadline cannot reliably observe the result.

## Consequences

The same process can converge after a failed effect or manual directory removal
without losing the original error. A non-returning filesystem operation still
holds its responsibility. Local closure and fresh absence do not prove that a
descendant detached from stdio cannot write later; the
[mutation closure decision](../architecture/2026-11-11-worker-git-mutation-closure.md)
describes that boundary.
