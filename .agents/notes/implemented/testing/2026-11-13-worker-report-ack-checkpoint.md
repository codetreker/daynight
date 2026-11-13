# Agent Note: Correlate Worker report acknowledgement with its checkpoint

Status: implemented

## Problem

A report recovery event can describe an earlier synchronization. Observing that
an expected request was sent, or observing an old checkpoint while a write is
still active, cannot establish whether a later receipt was accepted and stored.
A generation change can also make a successful exchange ignore an old receipt.

## Decision

The lost-bootstrap runtime test associates the fourth report's captured cursor
and generation with its exchange sync ID and remote receipt. It controls the
real checkpoint write and checks the pending and completed states against the
file bytes. Separate controlled cases exercise a retryable filesystem error and
an old-generation receipt while retaining the same report sequence. The
[canonical authority decision](../architecture/2026-11-12-worker-configuration-canonical-authority.md)
owns the product's generation and acknowledgement semantics.

## Alternatives

**Wait for a global recovery event and poll the cursor.** Recovery can precede
the fourth acknowledgement, and polling alone cannot distinguish an active
write, retry or ignored receipt when the cursor remains unchanged.

**Extend the fixed observation window.** A longer timeout cannot identify which
receipt completed or explain a blocked checkpoint.

## Consequences

The test uses controlled storage and exchange observations while retaining the
real manager, reporter and atomic file replacement. Its evidence distinguishes
pending, failed and ignored acknowledgements from a completed checkpoint; it
does not reconstruct unrecorded stages of a past CI failure.
