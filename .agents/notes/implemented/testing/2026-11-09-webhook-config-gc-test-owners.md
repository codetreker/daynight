# Agent Note: Webhook Configuration Collection Test Owners

Status: implemented

## Problem

Configuration collection tests executed the Core collector through PostgreSQL
to observe cached scans, pending barriers, busy-candidate selection and deletion
counts. The same cases also proved SQL scans, real transaction-ID barriers,
source locks, candidate locks and persisted deletion. A forced-passed barrier
separated the final deletion from unrelated cluster transactions, but left Core
decisions and database mechanisms coupled in one test.

## Decision

Core tests execute `ConfigCollector.Pass` through an ordered plan implementing
the existing Store and scope contracts. The plan checks context, full candidate,
cursor, limit, barrier and consumed calls. Callback execution and its expected
error are checked separately from independently supplied completion and write
errors. The mock supplies facts and outcomes without evolving stored records.

The receivers retain expired-key removal, a pending barrier followed by reuse of
the original scan, and skipping a busy endpoint or project before collecting the
second candidate. Driver-independent Store errors preserve the busy cause and
SQLSTATE. The existing unknown-outcome case retains its cached candidate, blocks
writes after an offline observation, and resumes scanning only after successful
observation with the original candidate cursor.

The [Retention configuration operation decision](2026-11-09-retention-config-operation-test-owners.md)
uses the same plan for five eligibility rules, a pending barrier and all 125
original configuration candidates. The later
[collector ownership decision](2026-11-10-retention-collector-operation-test-owners.md)
uses finite service operation results for budgets, context and lifecycle while
actual collector unknown state remains in the Core plans.

PostgreSQL tests call the actual scan, barrier, write scope, lock and delete
methods directly. An independently active earlier XID keeps the real barrier
false. After that transaction commits, the test proves the candidate's locked
deletion and fresh absence without requiring every earlier cluster transaction
to have ended. The existing prepared-transaction stress owner retains actual
barrier convergence. The [retention decision](../architecture/2026-11-08-webhook-retention.md)
owns the production capture and reclamation mechanism.

Busy cases preserve both real lock paths and the production 50 ms timeout.
Project source locking can fail before the operation callback; endpoint locking
fails inside it. Each case verifies rollback, then a separate committed deletion
and fresh SQL showing the first binding retained and the second removed. Held
transactions register bounded independent rollback cleanup immediately, with
cleanup errors reported except for an already closed transaction.

The expired-key fixture retains its original nanosecond input and absent owner
row. The stored expiry is compared at pgx/timestamptz microsecond precision, while
the actual database clock must be past expiry. Current-key, overlap-key and user
counts remain independent SQL observations.

## Alternatives

**Keep collector decisions in PostgreSQL tests.** This repeats lower mechanics
while making state-machine failures depend on schema preparation and SQL.

**Replace every database observation with a mock result.** Supplied completion
cannot prove transaction rollback, XID visibility, lock contention or persisted
rows. Those mechanisms remain real Store tests.

**Wait for the cluster barrier to become true after one transaction commits.**
Other packages can still own earlier XIDs. That adds an unrelated scheduling
condition to the locked-deletion proof; dedicated stress tests own convergence.

## Consequences

Core receivers execute without PostgreSQL. The Store cases retain their original
fixtures, two real busy waits, transaction completion and fresh readback. The
forced-passed wrapper and collector polling loops are unnecessary there.

These changes separate proof owners; they do not remove schema preparation or
the 50 ms lock waits. Comparisons include the additional Core receiver cost and
complete owning packages. Local case timings do not establish hosted CI savings.
