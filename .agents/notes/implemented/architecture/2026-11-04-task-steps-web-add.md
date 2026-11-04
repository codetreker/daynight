# Agent Note: Add Task Steps from the detail workspace

Status: implemented

## Problem

Adding a Step shares the parent Task version with other writes. An uncertain
receipt cannot prove that the new item was committed, and navigation or a late
response must not erase a different unsaved draft. Long collections also require
the confirmed item to be located without mounting every row.

## Decision

The Steps workspace retains one local form with a preselected task-local ID and
registers its dirty state with the existing navigation boundary. Its Markdown
preview uses the Task-root renderer. A separate request UUID binds each submission
to the form; a receipt for a discarded form cannot close a later one. Confirmed
results select the actual item's local page and focus its row. Relative insertion
uses the existing bounded target picker and retains the selected anchor by ID;
a missing anchor requires a new position decision without discarding the draft.

Project cache generation replacement can temporarily remove the admitted Task
detail even when this Task remains accessible. The reading workspace keeps its
draft mounted but hidden during re-admission, while clearing confirmed attachment
and Session content. Actual deletion or access and identity retirement still
discard it. The detail surface owns the discard confirmation's modal focus and
inerts the complete background; a suspended detail closes that portal.

The [shared session owner](2026-11-04-task-steps-web-status.md) serializes the
POST with Task and Step writes. It checks the complete 201 resource, Location,
submitted fields, version, requested position and unchanged existing rows before
accepting the result. Pending and unknown submissions freeze their fields; unrelated
writes only lock submission. Unknown results retain their original identity and
use read-only reconciliation without attributing the current collection to the
request or automatically replaying it. Retirement clears the private draft.

## Alternatives

**Give the form a separate writer.** This would split the shared version gate
and let Task and Step requests race from different baselines, while duplicating
identity, retirement and uncertain-result handling.

## Consequences

The draft survives pagination and same-task tab changes without entering the
detail cache. An uncertain outcome requires the user to inspect current facts
before deciding; reconciliation cannot establish the historical cause. Content
editing remains a separate capability.
