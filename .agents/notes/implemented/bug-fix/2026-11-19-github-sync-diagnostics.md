# Agent Note: GitHub Sync Diagnostic Ownership

Status: implemented

## Problem

A failed all-state scan can stop while fetching a list, confirming a candidate,
rechecking conflicting details, or processing an interleaved webhook hint. A
generic stop classification cannot distinguish these operations or show how much
work completed. Project bindings can change after execution, so looking up the
current binding cannot establish which repository and installation the failed
round actually used.

## Decision

Bind repository and installation log fields to the admitted connection after a
confirmed claim. Keep the existing App authorization and lease associations.
The [executor design](../../../../docs/design/github-sync-executor.md#结构化诊断)
owns the exact field and progress definitions.

Log detail outcomes at the shared current-detail confirmation boundary, where
initial reads and rechecks can be identified without wrapping the returned error.
Discovery supplies a progress snapshot to those reads and to bounded hint work.
Discovery-owned failures identify list, selection, publication or hint work;
hint records retain their own source and captured request/delivery identifiers.
Count committed publications even when the following renewal fails. Reuse the
existing typed error metadata sanitizer throughout.

This diagnostic decision complements the
[terminal discovery](../architecture/2026-11-18-github-terminal-pr-discovery.md)
and [App execution authorization](../architecture/2026-11-16-github-app-execution-fence.md)
decisions without changing their publication or recovery rules.

## Alternatives

**Add all diagnostic fields only to the final executor stop.** The stop boundary
does not know whether a list callback failed in hint processing or which detail
attempt failed. Recovering that information there would require changing the
error representation or mutable execution state shared across operations.

**Label every ListAll error as a list failure.** Its visitor also processes
webhook hints, so this would attribute hint rate limits and transaction failures
to the list endpoint and lose the original hint identity.

**Log raw errors to recover operation context.** Driver and transport errors can
contain private response content or parameters. Selected typed metadata provides
failure classification while preserving the original cause for callers.

## Consequences

Operators can correlate each admitted round with its original stable identities
and distinguish partial discovery progress from a completed natural or truncated
scan. Shared detail logging adds records for open, absence and hint confirmation
as well as discovery. Progress is an operation-boundary snapshot, not an atomic
database inventory, and discovery publication counts exclude independent hint
writes. Logs do not establish an unknown transaction's commit result or replace
the existing authorization fence. Structured JSON behavior tests own the logging
contract and sensitive-content exclusion.
