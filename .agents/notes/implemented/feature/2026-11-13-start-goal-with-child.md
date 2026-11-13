# Agent Note: Start a Goal with a Child Task

Status: implemented

## Problem

A child Task can be running while its Goal remains todo. The Goal's own status
then fails to reflect that work has begun, despite the child having a current
membership and a recorded start.

## Decision

When an ordinary Task actually enters `in_progress`, the shared Task write
transaction starts its current Parent Goal if that Goal is `todo`. Core owns
the transition rule and reuses the Goal lifecycle candidate; the service applies
it to both manual status changes and Worker claims under the Project write lock.
The Task and Goal commit or roll back together. The [Goal requirements](../../../../docs/spec/daynight-goals.md)
own the observable boundaries, and the [server design](../../../../docs/design/daynight-server.md)
owns the transaction mechanism. The earlier [Goal write and Worker admission
decision](../architecture/2026-11-11-goal-write-admission.md) still governs
terminal Goal admission.

## Alternatives

**Apply the rule only to the status candidate.** Worker claim constructs the
Task transition through a separate path, so this would miss automatic starts.

## Consequences

Concurrent child starts are serialized with Goal writes and only the first
start of a todo Goal advances its version and start time. Other Goal states,
child membership edits and later child lifecycle changes do not cause this
transition; Goal completion remains explicit. The additional parent read and
possible write occur within the existing Project transaction, and Goal changes
remain visible through normal reads and synchronization without a Task Webhook.
