# Agent Note: Session HTTP Tests Use DAO Mocks

Status: implemented

## Problem

Session HTTP tests prepared PostgreSQL, a UniAuth gateway, Project and Task
resources, Worker claims and sometimes a second complete application before
exercising a Session route. These prerequisites repeated storage, login and
unrelated HTTP work for adapter and transport rules. Some scenarios also used
SQL readback or a one-connection pool as an oracle, so removing the common
fixture required separating those observations from HTTP behavior.

The earlier [HTTP ownership](2026-11-06-server-http-proof-owners.md),
[protocol completion](2026-11-07-session-protocol-test-completion.md) and
[shutdown expectation](2026-11-07-session-deletion-shutdown-expectations.md)
decisions consolidated duplicate scenarios and corrected timing-dependent
assertions. Their initial fixtures retained real application and database
composition. This decision replaces that Session fixture allocation while
preserving their transport and cleanup observations.

## Decision

The regular `internal/server/session` suite assembles the production Session
service, real Session engine and actual routes. Production authentication uses
the Identity service with a narrow `IdentityWriter` supplying configured
credential facts through the [authentication fixture](../../../../packages/daynight-server/internal/server/session/authentication_fixture_test.go). Fixtures directly provide valid Task, Worker, Principal,
Session and terminal data. They require no database or gateway process and do
not create unrelated resources through HTTP.

The [shared backend](../../../../packages/daynight-server/internal/server/session/route_backend_fixture_test.go) declares the DAO calls and input snapshot for each
logical callback. Foreground operations have explicit finite use counts. Long-lived
channels declare their permitted repeated polling, and disconnect callbacks
have separate contracts. Missing, extra, unknown and late access fail, including
background failures; independent operations do not share a global FIFO.

Supplied read DTOs and write captures are independent. Tests assert proposed
parameters and explicitly select later phase inputs. Recording a write does
not change lookup, query or pagination results. Callback execution, proposed
writes and `committed`, `not_committed` or `unknown` completion remain distinct;
the actual engine owns live-state publication and cancellation. The
[Session core isolation decision](2026-11-08-session-test-dao-mocks.md) records
the same separation for core rules.

Native, terminal and archive fixtures retain the real HTTP adapter, WebSocket
connections, TCP behavior and local files needed by their scenarios. Archive
cases supply their own immutable inputs without opening an unrelated live
Controller. Existing large upload/readback and backpressure witnesses remain
transport tests. Test-local ping and body/socket durations use the existing
test construction seams; production intervals and the 120-second archive policy
retain their independent default checks and opt-in stress probes.

Physical proofs stay with their implementation owners. Store witnesses retain
[failed-disconnect rollback and its original cause](../../../../packages/daynight-server/internal/core/store/postgres/session_disconnect_witness_test.go),
[return of the writer's only physical connection](../../../../packages/daynight-server/internal/core/store/postgres/session_writer_connection_witness_test.go),
and [zero legacy event, timeline and resource rows](../../../../packages/daynight-server/internal/core/store/postgres/session_native_privacy_witness_test.go)
after native control-ledger writes. The [service preflight witness](../../../../packages/daynight-server/internal/service/session/archive_preflight_order_test.go)
checks transaction completion before residency decisions. The [Attachment HTTP witness](../../../../packages/daynight-server/internal/server/attachment/body_completion_socket_test.go)
owns consumed metadata body and next-request keepalive behavior. API integration
keeps its normal assembled flows.

Fixture shutdown drains the actual Session routes, stops the engine and checks
mock completion. Normal shutdown keeps the HTTP handler available for post-drain
`429` refusal checks. Fixture cleanup cancels the request lifetime after those
observations; an unexpected mock failure cancels it immediately and independently
fails the test. Scenario-selected clean domain faults use the existing exact
cause matcher: every joined cause must match, while operational errors, unknown
completion and unfinished drain remain visible failures. The
[server guide](../../../../packages/daynight-server/README.md#session-http-tests)
owns commands and resource boundaries.

## Alternatives

**Keep complete application, schema and login fixtures.** This historical
candidate supplies valid prerequisites but keeps non-Store adapter feedback
coupled to database and gateway setup. SQL and assembled normal-flow witnesses
already have their own owners.

**Mock the Execution callbacks or public service seam.** This would shorten DAO
plans but shift service completion and authority observations out of the
transport scenarios. Existing service and engine construction exercises those
paths without adding a production interface solely for tests.

**Use a generic ledger with automatic write promotion.** It would reproduce
query, persistence and rollback behavior inside the test fixture. A passing
scenario could then establish the simulator's behavior rather than the
service's use of supplied facts. Explicit phase inputs and independent spies
keep those responsibilities visible.

## Consequences

The regular Session HTTP selection executes without database or UniAuth fixture
configuration. HTTP parsing, authentication, protocol frames, socket shutdown,
backpressure and file bytes still cross their actual boundaries. The full Go
module check continues to run isolated PostgreSQL and assembled API validation
with its existing race and coverage gates.

Strict contracts require more explicit scenario preparation. Pre-welcome source
sequence, synchronization and first-input facts need their own phases;
background disconnect can race client closure; idle polling has a repeatable
channel lifetime. Relevant service changes must update those declared facts
and expected calls, with barriers retaining the required ordering. No generic
storage model hides that maintenance cost.

Source-bound validation artifacts retain runtime measurements and fault
comparisons. Package timings and a passing mock suite alone do not measure
whole-job improvement or establish physical database behavior.
