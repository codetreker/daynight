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
Project lock do not acquire a late parent row lock, avoiding a reversed order with
independent material and Session transactions. Goal status candidates carry
explicit lifecycle times. Goal writes return progress measured in the same scope.

Automatic candidates use an explicit internal selection intent applied before
pagination, and claim checks the current parent again under the Project lock.
Worker inventory retains children of ended Goals; deletion hides them and the
existing missing-inventory cleanup and owner-only archive paths remain responsible
for stopping and recording execution. The [Goal requirements](../../../../docs/spec/daynight-goals.md)
and [server design](../../../../docs/design/daynight-server.md) own the contract. The
[child-start decision](../feature/2026-11-13-start-goal-with-child.md) adds an atomic
start transition without changing terminal Goal claim admission.

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
