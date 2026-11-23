# Worker handoff and original-claim completion

Read [Overview](daynight://manuals/overview.md) first.

Use this topic for handoff, explicit Worker assignments and original-claim
completion. Every write also requires
[Write safety](daynight://manuals/write-safety.md). Use
[Concepts](daynight://manuals/concepts.md) to establish Account/Project identity,
[Task reads](daynight://manuals/tasks.md) for complete definitions and
[Task writes](daynight://manuals/task-writes.md) for ordinary lifecycle changes.

## Review a selected handoff

For each selected Task, read full content and actual required inputs. Verify
scope, acceptance/results, dependencies, status, platform, assignment, automatic
permission and execution history. Future predecessor outputs are not present
inputs. A well-defined blocked todo Task can be prepared before prerequisites
finish; acquisition remains blocked until scheduling permits it.

Independently establish the authenticated account through Concepts, then compare
its UUID to non-null `assignedTo`. Unknown/mismatching responsibility is a gap;
it does not authorize reassignment, access grants or duplicate work.

| State | Handoff action |
| --- | --- |
| `proposed` | Review authorized content; enabling permission cannot make proposed work executable. Choosing todo requires an explicit caller decision. |
| `todo`, permission false, inputs/responsibility sufficient | Authorized handoff may enable `allowAgents` at the decision version. |
| `todo`, unresolved inputs/responsibility | Report the gap and preserve assignment/permission. |
| `todo`, permission true | Review current facts; a same-value write is not a review receipt. |
| `in_progress` | Report execution and locked permission changes; changing status to bypass them is invalid. Review neither pauses nor transfers execution. |
| `done` / `cancelled` | Preserve the terminal result; handoff requires no reopening or permission change. |

To enable approved handoff, `task_update` supplies `allowAgents: true`, the exact
`ifVersion` and selected Project/Task IDs; omit unrelated fields. Inspect the
result and current assignment/execution/material: a Worker may claim immediately.
A later version, in-progress state or active history can be expected scheduling,
not grounds to repeat permission writing. Problems can require authorized
stopping/revocation/release by the management owner. Enabling permission neither
recreates a released worktree nor resumes its original claim.

## Recognize and retain a real assignment

Worker-managed execution requires an explicit runtime assignment naming original
Project, Task, claim, Worker, worktree and execution context. A generic MCP
connection, worker property, `allowAgents` or claim-like UUID cannot establish
it. Follow the original scope/contract, delivery authority, current user
restrictions, pauses/revocations and project checks; the claim field grants no
authority.

Preserve and verify original claim/resources before writes. Stop affected work
if the original active claim no longer matches or automatic permission is false
under the managed contract. Do not enable yourself, acquire another claim or
adopt another worktree. Release clears current ownership; the original Session
and archive retain history. Later execution has ordinary eligibility checks and
new identities.

Ordinary user-directed work follows Task writes and does not depend on automatic
permission/platform filters. Existing `in_progress` still requires reconciling
actual work and execution ownership. Without a valid Worker assignment,
ordinary completion supplies no `claimId`.

## Complete the original owned claim

Verify the selected outputs and required acceptance before completing. Every
direct prerequisite must be done/cancelled. Missing required acceptance preserves
the actual state; claim ownership cannot establish delivery.

`task_set_status` accepts explicit `claimId` only with `status: done`. For a real
completion transition with an active Worker, it validates the matching current
claim and caller ownership. Supply the valid assignment's original claim,
Project/Task IDs, exact decision `ifVersion` and desired status.

A current-version same-status request can return confirmed/unchanged before
claim ownership is rechecked. This establishes current Task state, not the
success of an earlier unknown completion or authentication of its original
claim. Version/input and compatible-Worker checks still apply. Do not switch
between ordinary and claim-bound paths after rejection to bypass protection.

Inspect the completion and retained original execution. Recover uncertain
completion by observing that scope without replay or attributing historical
completion from current state. Scheduling, controller ownership, release and
cleanup remain with their actual owner.

## Control boundaries

MCP business tools provide no general Worker registration, claim acquisition/
release, worktree creation or process control. Task cancellation/deletion/status
and permission toggles are not stop signals. Goals cannot be claimed; completing
or cancelling one prevents new automatic child claims while existing claims
continue. Ordinary cancellation/deletion of active Worker Tasks requires
authorized release; Goal deletion can hide children while executions stop later
through existing cleanup.

[Session selection](daynight://manuals/session-reads.md) and
[Session messages](daynight://manuals/session-messages.md) supply their advertised
inspection/message operations; neither establishes a Worker assignment.
