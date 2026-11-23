# Agent Note: Goal Dependency Lifecycle Protection

Status: implemented

## Problem

Goal acceptance can depend on work in another Project. A completed downstream Goal must not retain an unfinished prerequisite, even when completion and reopening race across Project transactions. Direct deletion must not leave references to a deleted Goal. Ordinary Task execution and automatic Parent start have independent rules and must remain usable.

## Decision

Goal edges use the [typed dependency store](2026-11-19-typed-dependency-storage.md). Goal lifecycle operations lock the local Project, then the current owner Team's transaction-scoped graph lock, before locking and rereading the Goal. Under that lock, completion requires every direct prerequisite to be done; leaving done is rejected while a completed downstream Goal depends on it. Direct deletion rejects live incoming references and removes outgoing edges with the Goal deletion. A persisted relationship revision advances once when outgoing edges are removed, and remains unchanged for an empty set. Revision exhaustion rolls back the transaction.

After type identification, the Goal branch uses a five-second budget covering its pool and lock waits, SQL and commit. Type identification retains the caller’s deadline. Refusals do not disclose the other endpoint. Ordinary Task operations and automatic Parent start do not acquire the graph lock. The [server design](../../../../docs/design/daynight-server.md#goal-验收依赖的生命周期保护) owns the current mechanism; Goal relationship editing and Project cleanup have separate responsibilities.

## Alternatives

**Lock only the two endpoints.** A graph operation can overlap another Project and affect relationships beyond those endpoints. A shared lock orders the relevant decisions without taking remote Task or Project row locks.

**Use one global graph lock.** This would serialize unrelated Teams. A Team lock protects the graph while allowing independent Teams to proceed.

**Only check Goal status before writing.** Separate Project transactions could observe compatible old states and commit an incompatible completed downstream and reopened prerequisite. The graph lock makes the check and write one ordered decision.

## Consequences

Goal status and deletion may wait behind another operation on the same Team; deadlines and transaction cleanup bound this wait. Cross-Project safety depends on all relationship and Project lifecycle mutations using the same lock order. Revision rows outlive an empty edge set so later operations can detect stale revisions. Existing ordinary Goal projections do not expose the new relationships.
