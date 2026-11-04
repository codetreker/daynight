# Agent Note: Delete Task Steps from the detail workspace

Status: implemented

## Problem

Deleting a Step shares the parent version with other writes and may remove the
record currently being edited. A lost receipt cannot establish what happened,
and removing a page's last row can leave keyboard focus without a target.

## Decision

The existing [shared write owner](2026-11-04-task-steps-web-status.md) submits
and validates deletion against the complete previous collection. The confirmation
identifies the record and explains the effects on its description, references
and any dirty draft. The form has its own identity so a confirmed late receipt
cannot clear a later draft. Once the validated result is admitted, the workspace
clears only that target draft and locates the next or previous Step by ID, or
the add control for an empty collection. Unknown outcomes retain the draft and
use the shared read-only recovery, without attributing observed state to the
request.

## Alternatives

**Discard the draft when deletion is requested.** Cancellation, refusal or an
unknown result would destroy user input without a confirmed deletion.

## Consequences

The delete action is available in every Step state and shares Task/Step write
exclusion. Recovery can show current existence but cannot prove a lost request's
history. Pagination bounds the mounted rows while focus follows stable IDs.
