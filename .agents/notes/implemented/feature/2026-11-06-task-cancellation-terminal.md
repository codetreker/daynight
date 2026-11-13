# Agent Note: Task cancellation as a readable terminal outcome

Status: implemented

## Problem

A task can cease to require delivery while its successors still need to proceed.
Using done for that result claims successful delivery; deleting it removes normal
access and graph membership. Neither expresses an ended task whose dependency
is satisfied and whose records remain readable.

The earlier [three-state decision](../../archived/architecture/2026-10-24-task-status-assignment.md)
removed task approval and unified ordinary state setting. Its original rationale
and proposed-to-todo migration remain valid historical decisions. Cancellation
extends the outcome model without restoring approval or parallel execution paths.

## Decision

Task has the additional irreversible cancelled state. It satisfies ordinary and
external dependencies as done does, but does not require its own prerequisites
or delivery to be complete. Done remains the successful-delivery result.

Cancellation preserves stored data and follows deletion's existing resource
cleanup boundary. The task, dependencies, descriptions, properties, Steps,
Thread, execution history and attachments remain normally readable under current
access checks. Cancellation does not set the deletion marker, remove graph nodes,
rotate the project epoch or close PRs and branches.

A database-generated cancelledAt records the cancellation independently of
startedAt and completedAt. The current terminal time is derived by status.
Protocol producers and first-party readers use the same five-state contract, including the later [proposed-state decision](2026-11-10-proposed-task-state.md),
with cancelled tasks retaining their ordinary materials. Persistent Web task caches
use an explicit schema rebuild rather than missing-field fallback.

Active ownership must be released before cancellation. Completed records and Session/archive history are retained. Release removes current ownership as described by the [release decision](../simplification/2026-11-12-release-clears-ownership.md). All todo-producing or execution-restoring operations reject
cancelled, including the separate withdrawal path. Existing Session freezing,
complete-inventory ownership reconciliation and terminal cleanup continue to own
stopping, archive gates, resource checks and retry state. Worker local lifecycle
states do not acquire a fourth status.

The [status requirements](../../../../docs/spec/daynight-task-status.md) and
[architecture](../../../../docs/design/daynight-task-status.md) own the current
contracts. Web uses the existing status menu and confirmation to cancel a task.
The confirmation retains reviewed identity, version and cache history and explains
irreversibility, readable materials and the dependency consequence. Active claims
require release first; no remote stop coordinator or reason form is added.
Cancelled state filtering keeps complete chain membership and progress intact.
Response and unknown-result handling remain with the existing status operation,
including preserved execution times and GET-only reconciliation.

## Alternatives

**Reuse soft deletion.** It shares retention and cleanup mechanisms, but hides
normal data access and removes the graph node. It cannot preserve the readable
terminal dependency required here.

**Use done plus a cancellation property.** It avoids another enum value, but
makes state queries, timing, progress and every consumer infer whether delivery
succeeded from a second field. The successful-delivery distinction would no
longer hold in the status contract.

**Add a cancellation-specific remote stop coordinator.** It could combine user
interaction with cross-machine stopping, but would duplicate established release,
Session fencing and cleanup ownership. The active-claim prerequisite provides a
clear refusal and retains existing stop confirmation.

## Consequences

Dependency satisfaction and ended counts include done and cancelled; successful
delivery counts only done. The [completion-progress decision](../bug-fix/2026-11-13-completion-progress-excludes-cancelled.md)
uses that distinction in Web presentation. Cancellation can release successors without changing
their versions or states. Web consumes the server's retained dependency facts
rather than inferring readiness from visible nodes; the [dependency-state
decision](../architecture/2026-11-11-task-sync-dependency-states.md) records
that projection and its ordering limit.

The additional required nullable time field needs coordinated protocol readers
and explicit persistent-cache migration. Distinct predicates prevent a broad
replacement of done checks from weakening start, completion or reopen rules.

Irreversibility must cover all restoration paths. In particular, historical execution cannot authorize withdrawal back to todo; a database constraint error is
not a substitute for an explicit domain refusal. Existing cleanup may remain
pending independently of the business terminal result.
