# Agent Note: Goal Write and Worker Admission

Status: implemented

## Problem

A Goal and its children share Task identity and materials, but a container has no
execution of its own. Ending or deleting the container must have distinct effects
on child visibility and automatic execution without rewriting child facts or
interrupting an existing claim at the wrong time.

## Decision

Core type policy separates Goal lifecycle, ownership and supported capabilities
from ordinary Task execution. A Project write transaction validates Parent and
serializes Goal status and deletion with new Worker claims. Parent reads under that
Project lock do not acquire a late parent row lock. Starting a Task prelocks its
complete target/direct-todo-Goal set in UUID order before Worker checks, as owned
by the [Task-parent read decision](2026-11-23-task-parent-read-projection.md). Goal status candidates carry
explicit lifecycle times. Goal writes return progress measured in the same scope.

Automatic candidates use an explicit internal selection intent applied before
pagination, and claim checks the current ancestor Goal again under the Project lock. Both
paths share the same-project recursive predicate through ordinary parents.
Worker inventory retains children of ended Goals; deletion hides them and the
existing missing-inventory cleanup and owner-only archive paths remain responsible
for stopping and recording execution. The [Goal requirements](../../../../docs/spec/daynight-goals.md)
and [server design](../../../../docs/design/daynight-server.md) own the contract. The
[child-start decision](../feature/2026-11-13-start-goal-with-child.md) adds an atomic
start transition without changing terminal Goal claim admission. The [Goal dependency lifecycle decision](2026-11-19-goal-dependency-lifecycle.md) adds Team-scoped serialization for explicit Goal status and direct deletion to protect acceptance relationships.

## Alternatives

**Cascade status and stop children.** This would alter child versions and execution
ownership and make Goal completion unexpectedly interrupt independent work.

**Filter only the candidate list.** A stale candidate could still be claimed after
its parent ends; final admission must observe the serialized current state.

## Consequences

Ending a Goal blocks new automatic claims without changing existing ones. Deletion
keeps physical child and dependency facts but removes ordinary access; cleanup begins
only after a successful inventory observation. The Project lock serializes related
writes and can limit write concurrency within one Project.
