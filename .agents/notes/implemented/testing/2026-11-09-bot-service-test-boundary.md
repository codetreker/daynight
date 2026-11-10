# Agent Note: Bot Service Test Boundary

Status: implemented

## Problem

Bot management tests prepared PostgreSQL identities, Workers, definitions and
Sessions to observe snapshot completion, native discovery and deletion cleanup.
Those flows also exercised creation replay, default-selection rules, physical
locks, preferences and rollback. Removing database preparation without retaining
those independent assertions would erase rule and persistence detection.

Native discovery must finish its read snapshot before contacting a Worker, then
carry its observation or failure into the creation transaction. A concurrent
committed definition remains authoritative even when discovery fails. Deletion
similarly separates durable admission revocation from physical file cleanup and
live Session eviction; a callback's proposed writes do not establish commit.

## Decision

`Bots` holds private instance-owned bindings for directly invoked core creation,
reads and selection operations. Both production constructors bind the original
implementations. Request normalization, fingerprints, cursor encoding and model
catalog transport remain real. `modelRequester` retains the authenticated Worker
request boundary, including the total deadline, response identity, pagination,
catalog consistency and bounded accumulation.

The service executes actual snapshot and write callbacks. Tests provide typed
lower results and errors independently of completion or cleanup, checking the
principal, canonical identity, normalized input, context, fingerprint, resolution,
current scope capabilities and call order. Read completion failures suppress
returned definitions and pages. Unconfirmed writes suppress their result and
retain operational error classification and cause chains.

`Deletions` binds core ownership, request, transition and persistence operations
on each instance. Tests supply those decisions while executing actual credential
admission and resampling, Session DAO calls, stop-proof validation, receipt
encoding, file removal, completion handling and live eviction. The production
clock remains `time.Now`. Structure/encoding helpers remain
ordinary code; test fixtures do not implement a Store or infer future reads from
recorded writes.

Deletion revokes Session authorization before saving its barrier. Only confirmed
commits publish live eviction, including a committed outcome accompanied by a
cleanup error. Server cleanup enumerates all associated Sessions, checks their
owner/scope/backend, removes each archive namespace before its row, then redacts
the Bot. A confirmed rollback of physical cleanup records failure in a separate
transaction without downgrading an already completed retry. Actual local-file
cleanup retains an orphan archive witness.

Each independent proof has an implementation owner:

| Owner | Proof |
|---|---|
| [Bot service](../../../../packages/daynight-server/internal/service/bot/) | Actual callbacks, normalization and paging adaptation, discovery between scopes, resolution/error propagation, completion/result contracts, credential resampling, stop proof and cleanup order |
| [Core Bot](../../../../packages/daynight-server/internal/core/bot/) | Creation identity, complete frozen replay, owner/Worker rules, configuration input boundaries, default/provider/native precedence, stale observations, deletion transitions, failed-receipt replay and version exhaustion |
| [PostgreSQL Bot](../../../../packages/daynight-server/internal/core/store/postgres/bot/) | Real creation locks, composite ownership, count pagination, complete stored configurations, availability inputs, preference ordering and rollback |
| [PostgreSQL Bot scope proofs](../../../../packages/daynight-server/internal/core/store/postgres/bot_definition_contract_test.go) | Definition credential recheck after an observed real lock, precise int64 deletion readback and independent Task state |
| [PostgreSQL Session scopes](../../../../packages/daynight-server/internal/core/store/postgres/session_scope_test.go) and [Bot scopes](../../../../packages/daynight-server/internal/core/store/postgres/bot_scope_test.go) | Shared transaction capabilities, credential/Session association, revocation, committed complete receipt/digest/version readback, rollback, retry and redaction readback |
| [Core Session deletion](../../../../packages/daynight-server/internal/core/session/bot_barrier_test.go) | Actual live-cache eviction, pending-reader cancellation and refusal of further access after observed Bot deletion |

The [dependency policy](2026-11-08-go-test-dependency-boundaries.md) owns the common
layering rule. The [runtime boundary](2026-11-09-bot-runtime-service-test-boundary.md)
remains independent. API integration owns representative normal flows through
the assembled server.

## Alternatives

**Keep PostgreSQL fixtures for service orchestration.** They exercise valuable
storage mechanisms, but obtaining fixed domain outcomes also repeats identity,
Worker and core setup. Physical locks and persisted observations belong with
their DAO/scope owners.

**Mock only DAOs beneath real core operations.** This removes the database but
still makes service outcomes depend on lower business decisions. Direct typed
operations expose exactly which facts the orchestration consumes.

**Replace deletion with one broad mock.** This would hide credential resampling,
actual Session/file order, stop-proof validation and commit-dependent live
eviction. Those mechanisms remain service responsibilities and execute in tests.

## Consequences

Ordinary Bot service feedback does not require database or authentication
fixtures. Private operation bindings require production-default coverage and
strict unexpected-call checks. Core and Store receivers still perform the lower
work, so target-package savings cannot be claimed as equal complete-command or
hosted CI savings. Source-bound logs and matched faults establish which original
assertions and detection remain; test counts and coverage alone do not.
