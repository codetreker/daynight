# Agent Note: Delete Task Steps from the detail workspace

Status: implemented

## Problem

Deleting a Step shares the parent version with other writes and may remove the
record currently being edited. A lost receipt cannot establish what happened,
and removing a page's last row can leave keyboard focus without a target.

## Decision

The existing [shared write owner](../../archived/architecture/2026-11-04-task-steps-web-status.md) submits
and validates deletion against the complete previous collection. The confirmation
identifies the record and explains the effects on its description, references
and any dirty draft. The form has its own identity so a confirmed late receipt
cannot clear a later draft. Cleanup uses the current shared confirmation for
the same request after error-free reconciliation and newer collection admission;
the panel stores no independent confirmation latch. Generation replacement
revokes the old delete confirmation before admitting new reads. The canceled
parent read's reservation and retry state are released so the shared read-only
recovery can admit the new history while the old receipt admission remains held.
Project revocation pauses recovery and clears private resources. Reauthorization
restarts read-only recovery for the now-unknown deletion in the new generation,
without replaying DELETE; writes resume after the three resources converge.
The workspace clears only that target draft and locates the next or previous Step by ID, or the add control
for an empty collection. Unknown outcomes retain the draft and use the shared
read-only recovery, without attributing observed state to the
request.

## Alternatives

**Discard the draft when deletion is requested.** Cancellation, refusal or an
unknown result would destroy user input without a confirmed deletion.

**Remember every validated confirmation in the panel.** This originally allowed
focus and cleanup to follow a transient receipt publication. A replacement cache
generation can retire that receipt before admission and reclassify the request
as unknown; the latch would discard input after the owner retracts confirmation.
The shared owner already preserves confirmed state through normal convergence.

**Wait for the old admission to reject its ticket.** A replacement parent and
Steps collection can finish first while the old admission remains suspended.
Preserving confirmed state until that rejection permits premature draft cleanup.
Generation replacement must revoke confirmation before either read is admitted.

**Require only current target absence.** Readback can show absence after an
unknown request without proving which history or operation removed the record.
Absence cannot authorize draft cleanup.

## Consequences

The delete action is available in every Step state and shares Task/Step write
exclusion. Recovery can show current existence but cannot prove a lost request's
history. Replacing cache history retains the draft even after an earlier
validated receipt, including when new readback overtakes old admission. Confirmation
in the same history survives hidden completion and reactivation. Cleanup waits
through reconciliation failures and cannot follow a different request. Pagination bounds the mounted rows while focus
follows stable IDs.
