# Agent Note: MCP Download Admission Fixtures

Status: implemented

## Problem

The download admission tests initialized Project, Task and transfer data to
reach validation, a pre-copy failure, or a duplicate request. Several checks
depend on deterministic Store results rather than persisted copy behavior.

## Decision

Controlled transaction scopes supply transfer states to the real download and
private transfer lifecycle operations. The tests keep exact authorization,
path and existing-binding checks. They supply independent reads before and
after a failed precheck to verify retry and reuse, and fail if either flow
unnecessarily starts a copy.

Actual PostgreSQL scopes and private files remain for contention, transfer
bytes, slot capacity, revocation and restart proofs.

## Alternatives

**Use native transfer inserts to prepare every admission case.** It supplies
real records but repeats setup for validation and independent read responses.

**Substitute the lifecycle operation.** That would remove the logic that
checks the transfer state or binding and touches the existing record.

## Consequences

The selected admission cases can run without PostgreSQL. Real file and Store
mechanisms retain their respective isolation requirements.
