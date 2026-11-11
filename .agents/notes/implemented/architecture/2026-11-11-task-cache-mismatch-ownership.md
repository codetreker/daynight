# Agent Note: Task Cache Identity Mismatch Ownership

Status: implemented

## Problem

A trusted response from another principal or a changed durable user fence makes
an existing cache operation unsafe. Destroying its scope before notifying the
account owner prevents that owner from retaining already displayed content while
it blocks further remote work.

## Decision

The cache synchronously notifies its account owner before rejecting a principal
mismatch or a transaction observing a replacement user fence. It neither clears
its projection nor adopts the replacement fence on those paths. The current root
owner invalidates the scope and starts identity verification; an owner that
retains content must synchronously pause admission. After notification, a
permanent mismatch fence ends admission waiters, aborts uncommitted ordinary
transactions, and prevents late success or denial from
publishing against the retained scope. Confirmed writes remain recorded. A
normal same-account pause does not set this fence, so trusted revocations still
apply. Project creation and settings settle dispatched writes as confirmed,
trusted refusal or unknown without publishing a late receipt or retrying an
unknown write. Their readers and other direct admission waiters stop on the
permanent fence; an untrusted error response cannot withdraw project content.
A peer's confirmed project withdrawal still withdraws matching retained
projections without reopening durable admission. Scope cleanup checks the bound
user fence in the same transaction before clearing durable rows, so an old owner
cannot erase a replacement lifecycle. The [task synchronization design](../../../../docs/design/daynight-task-sync.md)
owns the current lifecycle contract.

This changes the mismatch cleanup responsibility recorded in the historical
[persistent cache decision](../../archived/architecture/2026-10-24-persistent-task-summary-cache.md).
Corruption repair, logout and project access withdrawal retain their own cleanup
rules.

## Alternatives

**Destroy the scope before notifying the owner.** This prevents the owner from
retaining a previously published projection, even when it can stop remote work
without clearing the page.

## Consequences

The owner must enforce its chosen admission and cleanup policy synchronously.
The current root retains its destructive behavior, while another owner can pause
without losing the projection. Retaining content does not authorize new durable
reads or publication across a changed fence.
