# Agent Note: Retention Collector Operation Test Owners

Status: implemented

## Problem

Retention service tests originally executed configuration and receipt collectors
through DAO mocks to obtain eligibility, barrier and affected-row results.
Unknown helpers also used those native collectors to retain state between
activations. This coupled service aggregation and lifecycle observations to Core
selection rules, cursor state and per-candidate transaction setup. Separating the
operation boundary requires receiving those lower observations first.

The earlier DAO isolation removed database preparation while preserving native
collector state. Configuration operations were isolated first, with native
unknown helpers retained until complete Core reconciliation receivers existed.
The receipt and unknown receivers now permit one consistent ordinary service
boundary without losing the original state transitions.

## Decision

Retention consumes private configuration and receipt collector interfaces with
Reconcile and Pass operations. NewRetention binds one native pointer of each
kind; all methods and activations use those same objects. Constructor tests
check native type, pointer and separate-instance ownership without executing
collector rules. Production order, two-second deadline, category rotation,
500-row budget and 125-row quota remain unchanged.

Core uses strict plans over the existing Store contracts. The
[configuration collection plan](2026-11-09-webhook-config-gc-test-owners.md)
retains eligibility, pending barrier, busy candidates, cached scans and unknown
reconciliation. Receipt plans retain the original midnight nanosecond boundaries,
zero identity, invalid limits, full-namespace midday rules, all 125 original
identities, fence-busy cursor advancement and empty-page wrap. A real Pass saves
an uncertain receipt identity, failed readback retains it, successful readback
clears it, and the next scan uses the original cursor without replaying the write.
Safe error text and causes remain checked independently.

Plans verify complete context, identity, cursor, limit, times, order and consumed
calls. Callback execution and its expected error are separate from supplied
transaction completion and write errors. Returned facts never evolve into an
in-memory database. More precise 125-item identity/order checks and initial
lost-reply cause checks strengthen the former count/non-nil observations.

Ordinary service tests supply independent zero, one and 125-row collector
results through a finite plan queued before each actual driver activation. Both
collectors and real history operations share that activation's derived context,
actual Store identity and required local order. Failed reconciliation prohibits
new work; successful reconciliation precedes it. Cleanup checks the same injected
objects remain in use and every planned operation was consumed. Background
unexpected calls fail independently while cancellation and drain remain possible.
Different goroutines have no artificial global FIFO.

History callbacks still execute the actual step and scope. The two-argument
success callback supplies Committed/nil and reports an unexpected callback error;
its stress success consumers keep their ABI. Error families independently select
completion and check the actual callback cause. The original Step rule inputs,
locked time sampling, pending history readback and Unknown/NotCommitted distinction
remain intact.

Real Start/run/wait/Stop, single-flight admission, internal deadlines, observations,
redaction and goroutine drain remain exercised. Controlled operations provide
permanent errors, panics and cancellable blocking. The full-stream test queues
one activation per driver call and retains both producer barriers, the original
350-call cap, real buffer/drop behavior, full open-channel drain and bounded Stop.

PostgreSQL receipt tests retain actual candidate scans, operation fences, locked
expiry reads, deletion, commit and fresh SQL observations. A controlled stale
candidate updates the expiry in SQL and compares the lock-time value with the
actual stored timestamp. That exact-facts assertion strengthens the original
count/readback case: the DELETE expiry guard can mask a wrong Core expiry check
or stale expiry result, so those faults cannot be claimed as old SQL detections.

## Alternatives

**Keep collectors behind service DAO mocks.** This repeats lower rules and
transaction preparation while checking aggregation and lifetime. It also leaves
service tests responsible for private Core cursor and unknown state.

**Construct collectors per activation or bind methods to separate objects.**
That discards uncertain identities and scan positions. Native constructor checks,
controlled object-use assertions and real Core state bridges establish the
separate parts of the ownership requirement.

**Replace unknown and lifecycle cases with unconditional fixed results.** This
could hide missing reconciliation, replay or background work. Finite activation
plans and Core state bridges preserve those observations while real service
synchronization and history scopes remain active.

**Infer completion from callback errors.** This makes the fixture manufacture
rollback or commitment. Independent completion/error facts preserve unknown
outcomes and expose swallowed callback causes.

## Consequences

Core and ordinary service collector selections execute without database or
UniAuth fixtures. Service owns aggregation, quotas, timing, observations and
single-flight/lifecycle coordination; Core owns the collector state and choices;
Store owns physical fences, SQL and persisted rows. Supplied completion remains
distinct from persistence.

Comparisons include receiving Core cases and complete Core, Service and Store
packages. Removing repeated 125-item lower work does not establish a stable
runtime or hosted CI improvement. Paired faults retain detection where the old
oracle existed; exact read facts and stricter argument/cause checks are labeled
as strengthening.

Independent stress entry points remain unchanged. RetentionActive is a pure
supplied-snapshot predicate and LastRetentionActivity a pure maximum projection;
the real Step inputs legitimately exercise them without another operation hook.
This collector decision does not establish full Webhook test compliance.
