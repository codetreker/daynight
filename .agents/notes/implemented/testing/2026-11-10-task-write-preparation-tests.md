# Agent Note: Task Write Preparation Failure Tests

Status: implemented

## Problem

Task write preparation-failure witnesses controlled DAO reads while executing
real project authorization and Task business operations. This mixed service
transaction coordination with lower-layer decisions and did not verify the
service's direct operation inputs independently.

The earlier [Task service ownership decision](2026-11-08-task-service-test-ownership.md)
removed database setup while retaining these DAO-driven paths. This decision
partially supersedes that boundary for the selected failure witnesses.

## Decision

`NewTasks` binds project write authorization and Task Create, Update and Status
preparation operations per instance. The selected service tests execute public
entry points and the real write callback with controlled operations and scope
capabilities. They retain database error classification and unsafe completion
facts while checking the inputs and order of calls. Pure input validation and
candidate construction remain real.

Core tests execute each preparation operation with a failing DAO read and retain
the original error identity, chain and database or transaction facts. They do
not perform or simulate writes.

## Alternatives

**Retain DAO-driven service witnesses.** They preserve error paths but execute
lower business decisions and cannot independently verify operation arguments.

**Replace all Task write paths at once.** Successful mutations, assignment,
session and capture coordination have different boundaries and require their
own proofs; extending this failure-only seam would conflate those responsibilities.

## Consequences

The selected service tests isolate preparation failures without asserting
persistence or complete write coordination. Other Task service scenarios retain
their existing DAO-based fixtures, including status and version matrices. The
constructor's real bindings preserve production behavior and List assembly.
Comparisons include the receiving Core tests and do not imply a CI speedup.
