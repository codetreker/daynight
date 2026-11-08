# Agent Note: Session Tests Use DAO Mocks

Status: implemented

## Problem

Session tests mixed engine rules, service orchestration and PostgreSQL behavior.
A common fixture initialized and seeded a schema before exercising command,
terminal, content, archive and Bot state cases. Some tests changed rows merely
to obtain a lookup or authority result; others used SQL readback as the oracle
for caller-owned write arguments. This made Session rule feedback depend on a
concrete storage implementation and repeated database work across the suite.

Earlier [control-rule](2026-11-06-session-control-rule-isolation.md),
[command-rule](2026-11-06-session-command-rule-isolation.md),
[load-state](2026-11-06-session-load-state-isolation.md) and
[Bot preflight](2026-11-06-bot-registration-preflight-isolation.md) decisions
isolated selected rules while retaining surrounding PostgreSQL witnesses. That
split preserved distinct observations during the initial conversions, but left
the complete non-Store suite dependent on PostgreSQL.

## Decision

The complete `internal/core/session` suite uses synthetic domain records and
narrow `core/store` DAO, scope and transaction mocks. Pure functions use direct
inputs. Tests exercise real engine-owned state, protocol validation, files and
resource lifetimes; data access is an explicitly configured dependency.

Expected DAO calls belong to a context-local logical operation. Missing calls
fail when that phase finishes, and unconfigured, extra or late calls fail
immediately. Tests check arguments and use callbacks or barriers for required
ordering. Write DTOs are captured for assertions; later reads and query decisions
receive explicit scenario response facts.
Recording a write does not automatically change those responses. The fixture
does not implement a relational store, interpret SQL or infer durable state
from a recorded write. Transaction callback execution and proposed writes are
distinct from `committed`, `not_committed` and `unknown` completion; only
confirmed commit publishes successful live changes.

Session tests retain caller-owned interaction-ID propagation, credential and
permission rechecks, generation/fence rules, capacity rejection, rollback and
source ACK, archive identity, private-content exclusion, cancellation and live
cleanup. Controlled clocks and callback barriers establish expiry and ordering
without future-expiry sleeps. Background callbacks remain subject to failure
reporting, cancellation and drain.

Database-specific observations belong to Store tests: SQL mapping, constraints,
locks, snapshots, commit/rollback, stored reads and fresh database authority.
Existing Session DAO, Bot lifecycle, permission-transaction and Task Step
witnesses retain those mechanisms. Focused Store witnesses cover Task and Bot
archive/delete lock ordering, Session list filtering and pagination, and mixed
terminal history with original archive identity. Bot and Task service tests own
their cross-module orchestration; complete business fault matrices are not moved
into API integration tests.

The [test-writing rules](../../../../docs/writing_tests.md) own dependency
restrictions, and the [server test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the complete database-independent Session command. This decision replaces
the earlier choice to keep PostgreSQL witnesses inside the Session core suite;
their original rationale remains in the linked notes.

## Alternatives

**Keep the partial rule split and accelerate database fixtures.** Reusing schema
setup or shortening expiry windows would leave the non-Store suite coupled to
PostgreSQL and repeat database proofs outside their implementation owner.

**Replace PostgreSQL with a complete in-memory database.** An automatic store
would reproduce lookup, transaction and persistence semantics, need its own
validation and risk making a recorded write appear committed. Narrow configured
facts and write-argument assertions expose each dependency without that model.

**Remove database witnesses when converting Session tests.** DAO mocks cannot
prove row-lock compatibility, SQL mapping or real commit/rollback. Those
observations remain in their Store owners, while upper-layer decisions remain
in Session and service tests.

## Consequences

The complete Session suite executes without `DAYNIGHT_TEST_DATABASE_URL` and
without skipped database-dependent cases. Its feedback no longer includes
schema setup, seed, teardown or real future-expiry windows. Meaningful capacity
payloads, error paths, concurrency relationships and lifecycle checks remain.

Mocks require explicit dependency facts and exact write assertions. Store and
service witnesses must be checked when a new rule changes a database or
cross-module contract; a green mock suite alone cannot establish those
mechanisms. The full Go module check still requires isolated PostgreSQL for
Store and API tests and retains its race and coverage gates.

Source-bound before/after measurements and fault probes own the actual runtime
and preserved-detection evidence. Package savings do not directly establish
whole-job or hosted CI savings.
