# Agent Note: Session Image Occurrence Scope

Status: implemented

## Problem

An image source retry returns the existing capture receipt and can start new
source work. A status read can also reconcile a completed attempt and expose a
retry action. A credential's authority to read those facts and to request new
work can differ.

## Decision

The scoped Session execution checks read and control authority in the original
transaction before a retry is charged or written. An occurrence status read
checks read authority before reconciliation and projects `retry_source` only
with control authority. A missing control scope hides that action; other
authorization failures remain errors. The existing capture, retry identity,
copy continuation and Controller producer checks retain their responsibilities.
Task and Test Session registrations classify occurrence routes and implicit
HEAD alongside the dynamic action projection. Production assembly remains on
the existing profile until scoped activation. Scoped routes bind the execution
whose command admission was installed at construction; a read-only scoped
assembly continues to fail closed for restricted credentials.

## Alternatives

**Require control for every status read.** This would prevent read-only callers
from observing and settling an already completed attempt even though they cannot
start new source work.

**Accept control alone for a retry.** The existing response contains a full
capture receipt, so this would disclose data without read authority.

## Consequences

Read-only callers retain status and same-attempt settlement without receiving a
retry action. The scope check does not replace Session ownership, existing
resource access or producer fencing. Current production behavior remains
unchanged until the scoped services are assembled.
