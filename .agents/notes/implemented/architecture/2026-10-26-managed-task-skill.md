# Agent Note: Separate ordinary and managed task execution

Status: implemented

## Problem

Ordinary task execution and a worker-assigned claim have different lifecycle
owners. An ordinary executor may start a specified task and set its status;
a worker agent receives an execution that is already claimed and started, uses
controller-owned resources, and completes only its original claim. Putting both
lifecycles in the ordinary execution instructions makes every caller load
exceptions that belong to the worker environment.

The public skill also selected successive tasks through its autopilot mode.
That responsibility overlapped the worker's scheduling boundary and prevented a
single-task executor from having an unambiguous return point. Within one assigned
task, however, autonomous delivery still needs an explicit implementation,
publication, review, repair, and authorized merge loop. Treating every unmerged
PR as an external wait can end execution while routine CI or review is pending.

## Decision

The public `using-daynight` skill keeps one entrypoint and loads only the
reference selected for the current invocation. Ordinary specified tasks use
`references/run-task.md`. Only a worker startup prompt that explicitly names the
`worker-managed` environment, `using-daynight` skill, and
`autopilot-managed-task` mode selects
`references/autopilot-managed-task.md`. Task worker properties, working
directories, and environment variables do not establish that mode. The managed
mode follows the delivery flow of the separately installed `autopilot` skill
without requiring that skill at runtime or activating its session mode. A valid
worker-managed assignment already carries sufficient authorization for its
in-scope delivery, including PR merge. Its executor does not request separate
permission for those delivery steps. Explicit user restrictions, pause, and
revocation still apply. This assignment premise does not authorize unrelated
backlog work, deployment, destructive operations, or permission and protection
changes, and reading or editing its instructions does not establish an assignment.

Each execution reference owns its lifecycle. Ordinary execution handles its
version-bound start, recovery, and completion. Managed execution validates the
supplied project, task, original claim and worktree identities, branch, and
invocation configuration, preserves the already-started execution, and submits its
final version-bound completion through the existing explicit `--claim-id` API.
Missing or mismatched managed context leaves the invocation waiting. Rejection
or an unknown result does not select ordinary execution or replay the write.

`references/task-execution.md` owns the shared task-input, scope, delivery,
results, and completion-readiness rules. It does not start, reopen, or complete
an execution, select another task, or impose a claim on ordinary callers.
The existing task-content standard and Final acceptance rules retain their
respective ownership. The [task/session content decision](../process/2026-10-28-task-session-content.md)
keeps execution methods, operational authorization and recovery in session
context while task definitions, required inputs and artifacts remain task content. Managed execution does not enter ordinary execution and
skip selected steps.

Managed autopilot drives the assigned task through implementation, relevant
verification, focused publication, CI diagnosis, and review repair. It checks
introduced Critical/Major findings against the original scope, records deferred
improvements under the project's tracking rules, and handles each review thread.
The executor merges immediately once required checks, blocking-thread
resolution, current-head approvals, and mergeability meet repository rules,
without an additional permission request. Successful required checks and actual
reviewer approval for the current head remain mandatory; protections are never
bypassed. Platform-confirmed merge and its resulting commit establish delivery;
an auto-merge request or queue entry does not. Post-merge mainline CI is awaited
only when the user explicitly requires it. Required task acceptance, readable
results, and attributable temporary resource cleanup precede final claim-bound
completion because the worker may stop the
agent and remove its workspace immediately afterward.

Routine pending CI or review remains ongoing execution with bounded watches or
polls. A polling timeout is not a return condition. Demonstrated external
blockers such as unavailable credentials or reviewers, unmet human gates, and
explicit user restrictions or revocation preserve the original assignment,
actual state, minimum needed intervention, and next action before returning
waiting to the controller. A background executor does not ask the user questions. Its checkpoint retains the
original identities, workspace, authorization, scope, PR head, validation and
review state, owned resources, and next action without copying secrets. Recovery
refreshes the same active claim and current remote state before further writes.

The original public autopilot mode's automatic candidate-selection and
continuous successor loop are removed. Ordinary execution returns after one
specified task or an external wait. A user-directed Goal requirements-to-solution
discussion transition retains the Goal protocol's confirmation gates. Managed
autopilot returns to its controller after this task completes or needs external
intervention, without selecting another task or advancing a Goal stage. The
controller owns system-worktree, branch, and workspace cleanup; executors release
only attributable temporary resources within their authorization.

The worker runtime constructs the startup or relaunch prompt, including the
explicit environment, skill, mode and original assignment. The Herdr adapter
transports the caller's prompt to the corresponding native agent and reports
actual acceptance or uncertainty. The original skill separation defined their
input contract independently of those runtime deliveries. Reconnecting a live
agent does not itself authorize resending startup input.

This decision partially supersedes the
[public mode decision](../../archived/architecture/2026-10-21-using-daynight-modes.md) and the placement of
managed execution rules in the
[claim completion decision](2026-10-26-worker-managed-completion.md). Their
original routing rationale and the delivered CLI completion contract remain
part of the decision history.

## Alternatives

**Keep managed exceptions in ordinary run-task.** One file avoids shared-resource
links, but ordinary callers load worker lifecycle rules and managed callers must
interpret which ordinary steps to skip. That leaves the original ownership
ambiguity in place.

**Publish a separate private worker skill.** A worker-only bundle can keep even
the routing hint out of ordinary discovery. It also needs a separate delivery
and activation path across native agent hosts. A single skill with mutually
exclusive progressive loading satisfies the required isolation without that
additional installation boundary.

**Duplicate the delivery workflow in both execution references.** Independent
files can state their own completion gates, but changes to source ownership,
human acceptance, or PR delivery would require synchronized copies. A neutral
shared reference preserves one owner while keeping status transitions apart.
The managed reference supplies its autonomous delivery loop while applying those
shared readiness and acceptance rules.

## Consequences

Ordinary callers do not load managed claim and resource instructions. Worker
agents receive an explicit entrypoint, retain their original assignment, and
leave scheduling and system-worktree cleanup to the controller. Both paths
retain the same task-specific delivery and acceptance obligations. Managed
executors continue routine CI and review waits and distinguish actual external
blockers without expanding their authorization or task scope.

The skill does not continuously discover or select tasks. Automatic eligibility,
platform qualification, and scheduling remain responsibilities of their service
and worker consumers; public query and permission APIs are unchanged. The managed
mode's delivery instructions travel with the public bundle, so execution does
not depend on a separately installed autopilot version.

Whole-bundle installation and update carry the managed reference and its updated
routing and remove obsolete resource names. The original separation also removed
the public queue-selecting autopilot resource. Structural and installed-package
checks verify packaging; controlled agent scenarios verify actual instruction
loading and observable actions within their recorded fixture boundaries. Neither
replaces native Herdr or complete worker acceptance, and the original skill-only
delivery did not establish runtime or complete platform qualification.
