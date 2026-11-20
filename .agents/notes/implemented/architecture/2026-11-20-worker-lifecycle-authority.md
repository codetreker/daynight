# Agent Note: Independent Worker lifecycle authority

Status: implemented

## Problem

An offline Worker must retain an owner's decision to stop accepting work across
server and machine restarts. A saved target, disappearing heartbeat or empty Task
list does not prove that managed processes stopped. Concurrent claims and Session
inputs need a definite order relative to stopping, and a lost response must not
permit a late resume request to reopen admission after recovery has decided it
never committed.

## Decision

Worker lifecycle has an independent persistent resource and operation ledger,
with separate intent versions, management-instance epochs and received observation
sequences. Lifecycle and business admission serialize on the existing Worker row.
The lifecycle transaction never locks Tasks, Bots or Sessions in reverse order.
Credentials retain their original transaction-bound authorization before Worker
admission, including the existing scoped-service policy when enabled.

The ledger preserves original requests and receipts. Resolve obtains the same
Worker lock and either reads the committed result or persists a not-committed
tombstone. Resume activation has an independent child-phase request hash and
resolution, so resolving activation cannot erase the accepted intent. Fresh,
complete stopped and saved observations are required for explicit resume and
activation; initial bootstrap and normal reconnect have separate eligibility.

The [design](../../../../docs/design/worker-lifecycle.md) owns storage, lock order,
protocol integration and validation. The [Worker scope admission decision](2026-11-20-worker-scope-admission.md)
retains credential-policy rationale.

## Alternatives

**Extend configuration JSON.** Full configuration replacement, bootstrap imports,
legacy projections and configuration revisions have existing semantics. Adding
lifecycle fields there would still require an independent receipt ledger and
instance fencing, while allowing unrelated configuration writes to overwrite the
stop target. A separate resource adds DAO and protocol types but removes that
coupling.

**Check only the polling loop.** An accepted claim or input could pass an earlier
check and execute after stopping commits. Transaction-bound Worker admission
establishes the server ordering; the Worker and Controller still need their own
final local dispatch boundary and complete stopping inventory.

**Treat a missing operation as rolled back.** A delayed original transaction can
commit after the query. The terminal tombstone turns this observation into a
serialized refusal without replaying the original operation.

## Consequences

Lifecycle remains durable through server restart and independent configuration
changes. Existing clients without lifecycle rows retain their behavior, while old
business protocols cannot bypass an established closed gate. Additional tables,
phase-specific hashes and lock-order tests are necessary to preserve the unknown
write contract. The schema enforces the selected lifecycle enums, positive
versions, hash lengths and disabled/closed relationship as persisted invariants.

Server admission is not native process proof. Full Worker capability still
requires a persistent local veto, complete resource ownership and safe final
Provider dispatch. Server activation does not establish that the local gate was
opened, and platform acceptance remains separate from server protocol tests.
