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
That responsibility overlaps the worker's scheduling boundary and prevents a
single-task executor from having an unambiguous return point.

## Decision

The public `using-daynight` skill keeps one entrypoint and loads only the
reference selected for the current invocation. Ordinary specified tasks use
`references/run-task.md`. Only a worker startup prompt that explicitly names the
`worker-managed` environment, `using-daynight` skill, and
`execute-task-in-managed` mode selects
`references/execute-task-in-managed.md`. Task worker properties, working
directories, and environment variables do not establish that mode.

Each execution reference owns its lifecycle. Ordinary execution handles its
version-bound start, recovery, and completion. Managed execution validates the
supplied project, task, original claim and worktree identities, branch, and
invocation configuration, preserves the already-started execution, and submits its
final version-bound completion through the existing explicit `--claim-id` API.
Missing or mismatched managed context leaves the invocation waiting. Rejection
or an unknown result does not select ordinary execution or replay the write.

`references/task-execution.md` owns the shared task-input, scope, delivery,
evidence, and completion-readiness rules. It does not start, reopen, or complete
an execution, select another task, or impose a claim on ordinary callers.
The existing task-content standard and Final acceptance rules retain their
respective ownership. Managed execution does not enter ordinary execution and
skip selected steps.

The autopilot mode and its automatic candidate-selection and continuous
successor loop are removed. Ordinary execution returns after one specified
task or an external wait. A user-directed Goal requirements-to-solution
discussion transition retains the Goal protocol's confirmation gates. Managed
execution returns to its controller without advancing a task or Goal stage.

The worker runtime constructs the startup or relaunch prompt, including the
explicit environment, skill, mode and original assignment. The Herdr adapter
transports the caller's prompt to the corresponding native agent and reports
actual acceptance or uncertainty. This skill change defines their input
contract; it does not implement those runtime components. Reconnecting a live
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

## Consequences

Ordinary callers no longer load managed claim and resource instructions. Worker
agents receive an explicit entrypoint, retain their original assignment, and
leave scheduling and system-worktree cleanup to the controller. Both paths
retain the same task-specific delivery and acceptance obligations.

The skill no longer continuously discovers or selects tasks. Automatic
eligibility, platform qualification, and scheduling remain responsibilities of
their service and worker consumers; public query and permission APIs are
unchanged. Native startup, prompt transport, recovery, and complete platform
qualification still need their corresponding runtime deliveries.

Whole-bundle installation and update carry the new references and remove the
deleted autopilot resource. Structural and installed-package checks verify
packaging; controlled agent scenarios verify actual instruction loading and
observable actions within their recorded fixture boundaries. Neither replaces
native Herdr or complete worker acceptance.
