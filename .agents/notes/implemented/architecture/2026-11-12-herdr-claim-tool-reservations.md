# Agent Note: Herdr claim tool reservations

Status: implemented

## Problem

A Worker selects Herdr before sending a claim request, but only registers the
local pending task after a grant arrives. Independent configuration reporting can
replace an otherwise idle shared daemon during that request. The eventual grant
then owns a frozen selection that no longer matches the daemon. A lost response
or process restart also loses the selected configuration before inventory finds
the grant.

## Decision

Frozen Herdr claims use an independent SQLite request reservation. It records the
original Project, Task, claim, worktree, Worker, exact candidate version and
native configuration. Shared-instance admission verifies the selected daemon and
persists the reservation under the same mutex used for replacement. The request
is sent only after that transaction completes. Reservations prevent replacing
the shared selection and submitting another claim for the same Task; they do not
create pending tasks, worktrees, Sessions or execution capacity.

A matching active grant atomically creates pending state, saves the original
configuration and removes the reservation. Pause or permission withdrawal does
not erase a granted responsibility. Original-task reconciliation precedes daemon
recovery and Agent capacity admission. An authorized pending claim may restore
its original stopped daemon without starting its Agent.

Uncertain requests are never replayed. Explicitly unsubmitted requests and
confirmed POST refusals can release their reservation. Otherwise, only a newer
original Task version without that active claim, or its trusted deletion
tombstone, fences the original request. Tombstone reconciliation requires a
complete inventory for the Project that remains valid after the scoped Task
read. Only a confirmed `task.show` response with status 410, code `task_deleted`
and the exact reserved Project/Task can release the reservation. Cancellation,
unconfirmed outcomes, conflicting identities and unavailable Project observations
retain the original responsibility. Inventory absence, the same version and
other read failures are insufficient. The
[Herdr design](../../../../docs/design/herdr-tool-launch.md#共享实例切换与恢复)
owns the protocol and recovery order.

The [minimal claim record decision](../../archived/simplification/2026-10-27-worker-claim-records.md)
keeps actual claims in the task index. The separate reservation preserves that
distinction while replacing the process-only request policy for
[frozen Herdr launches](2026-11-12-herdr-frozen-tool-launch.md), whose selected
daemon can otherwise change before the grant is registered.

## Alternatives

**Count requests only in memory.** This closes the immediate switching window
but loses the selected configuration on restart or an unknown response.

**Register pending before sending the request.** This treats an attempted claim
as an actual grant and feeds unowned tasks into execution and cleanup paths.

**Release when the claim is absent from inventory.** The request can still
commit after that snapshot at the same version. A newer Task version or a
confirmed refusal is needed to fence it; an exact Task deletion tombstone also
prevents that request from acquiring a claim.

**Retain every failed Task read indefinitely.** This preserves ambiguous reads
but also retains a reservation after an ungranted Task is authoritatively
deleted, permanently blocking a different shared Herdr selection. The trusted
deletion response is terminal evidence. A generic 404, permission failure or
another resource's response does not provide that guarantee.

## Consequences

Worker SQLite version 16 separates attempted claims from actual local tasks and
preserves exact versions beyond JavaScript's safe integer range. Grant transfer
is a single database transaction; failed transfer keeps the original reservation.
The extra record remains until decisive evidence arrives, so unavailable or
unchanged Task reads can keep a shared tool replacement pending. It does not
weaken the original process, endpoint, mapping, permission or capacity checks.
