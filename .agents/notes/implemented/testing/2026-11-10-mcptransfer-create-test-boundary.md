# Agent Note: MCP Transfer Create Test Boundary

Status: implemented

## Problem

Lifecycle service tests controlled the private-transfer DAO but still executed
Core `Create` through it. The active-slot rules and ledger sequence were therefore
mixed with Service authorization, duplicate handling and transaction completion.
The DAO-only fixture did not verify the directly invoked business operation as
an independent collaborator.

## Decision

`Lifecycle` binds its private `Create` operation to Core in its constructor.
Service tests control that operation per instance and verify the original
context, transaction-bound DAO, complete initial record, call order and independent
operation and completion outcomes. Existing-record retries do not invoke Create.
The real input validation, record construction, binding checks and authorization
mapping remain in Service tests.

Core tests execute `Create` with a strict narrow DAO and own all five active-slot
counts, the duplicate path and the complete insertion input and returned record.
The existing Core failure cases remain. Neither a supplied operation result nor a
transaction completion outcome establishes physical persistence. Store and
process witnesses continue to own real SQL, file and recovery effects.

The [MCP transfer ownership decision](2026-11-09-mcptransfer-test-ownership.md)
retains the earlier DAO and attachment isolation rationale and physical proofs.
This decision replaces its DAO-only boundary for Create; Reserve, reservation
consumption, updates, commit and maintenance operations remain outside this
operation isolation.

## Alternatives

**Keep Create behind DAO expectations in Service.** This exercises Core's ledger
rules repeatedly while leaving the operation arguments and outcome coupled to
its implementation. Core can verify those rules directly with a narrower DAO.

**Replace the lifecycle and files with supplied outcomes.** This would lose the
actual permit, gate, stream, cleanup and recovery observations that operation
mocks cannot establish.

## Consequences

Service proves coordination and Core proves the Create slot rules without
claiming that the whole Lifecycle suite isolates every direct business operation.
The production constructor, slot limit, transaction semantics and resource
mechanisms remain unchanged. Performance comparisons must include both receiving
and originating packages under matching conditions; moving work alone does not
establish a CI speedup.
