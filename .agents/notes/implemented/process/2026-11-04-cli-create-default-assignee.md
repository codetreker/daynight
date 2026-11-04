# Agent Note: Account-owned task handoff

Status: implemented

## Problem

A task created through the CLI can omit its responsible person. Automatic worker
acquisition requires assignment to the worker's authenticated account, so enabling
automatic execution alone does not make that task eligible for its creator's
workers. Assigning the intended person should not require a separate mutation
for ordinary CLI creation. Handoff also needs to distinguish a complete task
from one that the current account's workers can acquire.

## Decision

CLI task creation without an explicit --assigned-to resolves the authenticated
account with the existing getCurrentUser() request and submits its UUID as
assignedTo. Both reads and creation use the same ServerSession and credential.
A failed identity lookup or cancellation prevents the create request. An explicit
UUID keeps its existing normalization and access checks and skips identity lookup.

This is a CLI default within the existing
[assignment foundation](../architecture/2026-11-03-task-assignment-foundation.md).
The API and service continue to accept omitted or null assignment, and callers
may explicitly select another qualified account. Task updates preserve omitted
assignment. Creation still produces todo with automatic execution disabled;
execution startup and original claim authority retain their own rules.

Handoff verifies responsibility with the existing complete task list filtered by
assigned-to me, including all statuses and no readiness, permission or platform
filters. The selected ID, non-null assignee and exact version must match the full
reviewed task. This reuses the list client's authenticated-principal validation
without another identity command. Only content and responsibility checks together
permit enabling automatic execution. Missing, mismatched or unreadable ownership
blocks enablement without automatic reassignment. Already-enabled tasks remain
read-only on a failed check; existing claims retain their original authority.
The [content-sufficient handoff decision](2026-10-25-task-content-handoff.md) owns
the content review and reconciliation rules.

## Alternatives

**Assign during handoff and execution startup.** This would leave creation
unassigned and require additional writes before those operations, including
version reconciliation and the existing permission reset on reassignment.
A creation default establishes ordinary responsibility in the initial write.

**Force self-assignment in the service.** This would change the shared API's
optional responsibility model and prevent callers from intentionally creating
unassigned work. The CLI supplies the intended value without changing that model.

## Consequences

Default CLI creation adds one authenticated read before its mutation and exposes
identity lookup failures before a task exists. Explicit assignment adds no read.
The server remains the authority for assignee eligibility, and the CLI's existing
create response validation checks the submitted assignee. Existing tasks and
other clients keep their current responsibility values and defaults.

Handoff adds a complete account-filtered list read, so its cost follows the
account's project task inventory. Exact-version enabling prevents a reassignment
after review from silently authorizing another owner. Independent attachments
and list pages still do not form an atomic snapshot; content checks and final
readback retain their existing limits.
