# Agent Note: Accept only Web execution writes

Status: implemented

## Problem

Old Workers can request Herdr claims or advance existing executions even when
Worker coordination no longer owns those resources. Historical claims must remain
readable and available for explicit user disposition without admitting new
execution work.

## Decision

New claims require an explicit Web mode for each supported provider. Execution
updates accept only Web claims and reject nonempty Herdr resources. The current
Web wire may still carry `herdr:null`. Stored claims retain their original modes
and resources; manual release and withdrawal remain available. Historical
migration and stored decoding retain their broader format. The
[claim design](../../../../docs/design/daynight-worker-claims.md) owns the
operation contract.

This narrows the new-write behavior of the archived [mode contract](../../archived/architecture/2026-10-27-task-session-mode-contract.md)
and complements [Web-only coordination](2026-11-17-web-only-worker-coordination.md).

## Alternatives

**Continue accepting Herdr execution writes.** Older Workers could create or
advance executions whose resources the current coordinator no longer manages.

**Remove Herdr from stored decoding and the wire at once.** Historical claims
would lose their meaning and existing Web producers still send the null slot.
Stored history and the remaining wire consumers have separate lifetimes.

## Consequences

Old clients must use a supported Web execution path for new claims. Existing
Herdr claims and resources remain under user control; rejecting a write does not
stop or clean a process. Historical reads and manual disposition retain their
existing permission and version checks.
