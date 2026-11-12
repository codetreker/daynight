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
original Task version without that active claim fences the original request.
Inventory absence, the same version and read failures retain it. Conflicting
identity evidence remains an error. The
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
confirmed refusal is needed to fence it.

## Consequences

Worker SQLite version 16 separates attempted claims from actual local tasks and
preserves exact versions beyond JavaScript's safe integer range. Grant transfer
is a single database transaction; failed transfer keeps the original reservation.
The extra record remains until decisive evidence arrives, so unavailable or
unchanged Task reads can keep a shared tool replacement pending. It does not
weaken the original process, endpoint, mapping, permission or capacity checks.
