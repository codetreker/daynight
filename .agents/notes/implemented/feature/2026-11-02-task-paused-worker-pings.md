# Agent Note: Pause worker continuation through a task property

Status: implemented

## Problem

A worker can observe an idle native agent while the task still needs delivery.
Periodic continuation is useful for that case, but an operator also needs to
keep the same execution available for intervention without the worker repeatedly
submitting more continuation input. Native activity and task completion do not
express that intent.

The decision can become stale while a task operation waits for its workspace
lock or the native input surface. A pause observed only in an earlier inventory
cannot reliably prevent the later prompt. Suppressing input must also preserve
submission history so that removing the pause can restore normal continuation.

## Decision

The server registers the writable boolean task property `paused`. Its value uses
the existing property resource, task-wide version and independent property row
under the [property storage decision](../architecture/2026-10-30-task-property-rows.md).
Setting `true` suppresses periodic worker continuation pings; `false` or absence
permits the existing policy. Reads do not insert a default key. Explicit false
remains a stored value, removal deletes the row, and malformed present values
fail instead of being interpreted as false. The property is mutable while a
claim is active, preserving task status, timing, ownership and other properties.

The [agent patrol decision](../bug-fix/2026-10-27-worker-agent-patrol.md) continues
to own native activity and submission baselines. Only periodic continuation uses
a pre-submission guard. After workspace serialization and native readiness
checks, the guard reads the current service task and verifies the original
active claim, worker and worktree before checking `paused`. It does not rely on
the earlier inventory or a second local pause store. A failed read sends no
prompt and retains its error chain; a changed claim never authorizes input to
the replacement execution.

A guard skip is an explicit unsubmitted result. It retains the previous input
baseline rather than recording a submitted or uncertain prompt. When the
property becomes false or absent, the same native observation can therefore
qualify for a new continuation. Existing rules still govern acknowledged and
unknown submission outcomes.

This property gates periodic continuation only. It does not stop a running
agent, change task status or worker phase, affect acquisition, or block initial
and deferred assignments, recovery, cleanup and manual interaction. Web execution
currently emits no periodic continuation pings. Managed intervention instructions
retain reporting, waiting context, original assignment verification and resolution
before resuming without a signaling-property protocol. They do not automatically
set or clear `paused`.

## Alternatives

**Add a top-level task field and dedicated commands.** Existing registered
properties already provide strict boolean validation, versioned updates and
complete reads. A new task column, DTO field and command path would duplicate
those mechanisms for the same control.

**Inspect only the inventory snapshot.** This avoids a service read at the
native mutation boundary, but workspace queues and readiness waits can outlive
the snapshot. A pause set during those waits would be ignored by the pending
continuation.

**Suppress every task operation while paused.** That would also suppress the
observation, recovery and cleanup needed to preserve the original execution.
The requested control is limited to continuation input, so it belongs at that
submission boundary.

**Record a skipped prompt as submitted.** This suppresses the same observation
on later patrols, but can leave a newly unpaused task idle until native state
changes for an unrelated reason. Only actual submissions establish a new input
baseline.

## Consequences

The generic commands expose pause control without a new command family or Web
control. Operators use `task set-property TASK_ID paused true`, set false, or
remove the property with the usual exact-version rules. Storage and full task
projections need no migration or default-value injection.

Each periodic native input decision requires a current authenticated service
read. A service failure prevents the ping while preserving observation and
error visibility. The service read and native mutation are separate systems;
a pause committed after the final check does not retract input already sent or
accepted. The flag is not an immediate stop or a new execution-ownership state.

Controlled tests cover boolean/resource semantics, pause and unpause with an
unchanged native observation, last-moment checks after native waits, read failures,
claim changes and unaffected assignment/cleanup paths. These checks do not claim
real-provider delivery or three-platform end-to-end acceptance.
