# Agent Note: Reconcile inherited Worker initial input independently of native readiness

Status: implemented

## Problem

A recovered Controller generation inherits the original initial operation and
its delivery state in the same journal. A ready native process can therefore
coexist with a dispatching or unknown initial input. Requiring input acceptance
to clear an orchestration block rejects that original execution indefinitely;
requiring every receipt to belong to the current generation also rejects its
legitimate predecessor operation. Replaying the input could duplicate work whose
Provider acceptance has not yet been observed.

## Decision

Original native readiness and initial-input acceptance have separate gates.
Backend verification and the store's atomic orchestration clearing share the
original-generation readiness rule. Later generations without pending retry,
native pause or shutdown intent may observe an inherited initial operation after
the existing worktree, ticket, journal, authenticated IPC, native identity and
process proofs pass. Accepted evidence cannot regress to a pending state.

The current ticket authenticates the journal and current execution snapshot in
the same read transaction as the original operation. An inherited operation must
match the original operation ID, initial kind, frozen text and payload hash; its
generation must be a positive predecessor of the current generation. First-
generation input and new assignment or ping operations retain their current-
generation checks. Legacy branch-latch correction retains its accepted-input
requirement. This refines the [orchestration decision](2026-11-05-worker-orchestration-blocks.md)
and the [patrol decision](../architecture/2026-11-17-web-worker-patrol.md).

Ordinary advancement and orchestration recovery use the same read-only initial
input reconciliation. Uncertain delivery keeps the original operation, Session,
generation and recovery budget. Continuation requires both an accepted receipt
and a fresh accepted snapshot for that generation. Rebuilding transient Worker
progress does not resubmit the original input. The [Worker design](../../../../docs/design/daynight-worker.md#web-backend-与执行证据)
owns the complete mechanism.

## Alternatives

**Require initial acceptance before clearing every orchestration block.** This
confuses input delivery with native readiness and prevents a valid recovered
generation from reaching its existing receipt-observation path.

**Accept any earlier operation or infer acceptance from a healthy Controller.**
Neither establishes the original input's content or Provider outcome. Exact
journal ownership and payload checks preserve the dispatch fence.

**Resume continuation immediately on an accepted receipt.** Snapshot and receipt
reads can straddle Controller updates. Retaining the pending observation until
the current generation also reports acceptance prevents a stale snapshot from
re-entering input submission.

## Consequences

Temporary orchestration failures can recover while original input delivery is
still uncertain, without another launch, generation, input or recovery attempt.
The change uses existing tickets, journal records and waiting states; it adds no
storage or wire format. Missing or conflicting provenance remains a visible
failure, and genuinely unknown delivery can wait indefinitely. Fixture-based
regression proves the local state transitions, not acceptance by a live Provider
or the precise field values of an earlier production incident.
