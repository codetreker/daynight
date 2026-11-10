# Agent Note: Private Transfer Reservation Test Ownership

Status: implemented

## Problem

Reservation and consumption tests through PostgreSQL combined Core admission,
amount and version rules with SQL arithmetic and transaction outcomes. A mutable
DAO mock also derived later results from writes, coupling the rule oracle to the
fixture's arithmetic. Neither a mock receipt nor recorded calls can establish
that accounting and receipt data persisted or rolled back together.

## Decision

Core reservation tests supply independent read facts, operation results and
expected records through a strict DAO plan. They own the reservation budget,
record overflow, consumption amount and version rules, error propagation and
call order. Unexpected or unconsumed calls fail; supplied writes do not create
later read facts.

The PostgreSQL private-transfer DAO remains in the root implementation package.
Its tests construct legal fixed records directly through the real DAO and prove
ledger and row arithmetic, receipt failure rollback, successful receipt commits,
and independent persisted readback. They acquire a transfer lock before the
ledger lock. The maximum bigint case verifies real row and ledger values; Core
owns the refusal of an additional byte. Other private-transfer lock, concurrency,
failure and lifecycle witnesses retain their existing owners.

This applies the [PostgreSQL ownership decision](2026-11-09-postgres-test-ownership.md)
and complements the [MCP transfer ownership decision](2026-11-09-mcptransfer-test-ownership.md).
The latter retains Service's DAO boundary and physical resource proofs.

## Alternatives

**Keep the Core rules inside PostgreSQL scenarios.** Real storage proves SQL and
transaction behavior, but also makes admission failures depend on a database
fixture and obscures which layer owns the rule.

**Replace receipt and ledger observations with mock outcomes.** A supplied
result cannot demonstrate actual transaction rollback, commit or persisted
arithmetic. Those observations require an isolated real database.

## Consequences

Core rules execute without PostgreSQL, while SQL and transaction tests retain
their real backend and lock ordering. Both sides must execute to preserve the
original independent inputs and observations. Comparable performance evidence
includes the receiving Core tests and the Store tests under matching conditions;
moving rules alone does not establish a command or CI improvement.
