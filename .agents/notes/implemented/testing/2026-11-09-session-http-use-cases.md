# Agent Note: Session HTTP Use Cases

Status: implemented

## Problem

Session HTTP tests prepared PostgreSQL, a UniAuth gateway, Project and Task
resources, Worker claims and sometimes a second complete application before
exercising a Session route. These prerequisites repeated storage, login and
unrelated HTTP work for adapter and transport rules. Some scenarios also used
SQL readback or a one-connection pool as an oracle, so changing the collaborator
boundary required assigning each observation to its implementation owner.

The earlier [HTTP ownership](2026-11-06-server-http-proof-owners.md),
[protocol completion](2026-11-07-session-protocol-test-completion.md) and
[shutdown expectation](2026-11-07-session-deletion-shutdown-expectations.md)
decisions consolidated duplicate scenarios and corrected timing-dependent
assertions. Their original full-application fixtures explain that history;
HTTP unit responsibilities follow the
[Go dependency decision](2026-11-08-go-test-dependency-boundaries.md).

## Decision

The regular `internal/server/session` suite executes actual routes with direct
Session use-case mocks. The private
[service binding](../../../../packages/daynight-server/internal/server/session/service_calls.go)
projects existing production methods into typed callbacks. Test-only aliases
provide those same calls without constructing a real service, engine or DAO.
No whole-application interface or persistence simulator is introduced.

Production `RequestAuthentication` retains Bearer, cookie, Origin and request
identity handling with a configured credential callback. The
[authentication fixture](../../../../packages/daynight-server/internal/server/session/authentication_fixture_test.go)
checks the credential kind, token, result and expected calls. Identity account,
login and gateway work remain outside this HTTP unit dependency.

The [use-case mock](../../../../packages/daynight-server/internal/server/session/route_backend_fixture_test.go)
requires configured calls, checks finite foreground counts and fails on unknown,
extra or missing access. Repeated channel polling is explicitly declared by its
scenario. Tests check context, principal, canonical addresses, fences, message
parameters and returned projections. Callback barriers establish required order
and cancellation; independent goroutines do not require a global FIFO.
Supplied replies remain separate from captured requests, with no automatic
business transition, lookup policy or write promotion.

HTTP, WebSocket and TCP mechanisms remain real. Tests read actual published
frames, Ping/Pong exchanges, generation changes and revocation/deletion closure.
Pending upgrades and disconnect callbacks retain their drain observations.
Normal route shutdown permits subsequent HTTP `429` refusal checks; fixture
cleanup cancels request lifetimes after those observations. Unexpected mock
failures cancel them immediately and independently fail the test. The exact
clean-cause matcher still rejects mixed errors and unfinished drain.

Archive calls exchange an opaque preflight reservation, an upload operation or
returned bytes with a separate closeable lease. Tests verify reservation identity,
mode, body bytes and exactly-once operation/lease closing. They do not need Core
reservation objects or files. Actual body reading, backpressure and the existing
16 MiB upload/readback remain socket observations. Test-local durations retain
the production 120-second default assertion and separate full-duration stress
probes. Core owns eligibility, integrity, storage and residency rules.

The receiving proof owners are explicit:

- The [service completion witness](../../../../packages/daynight-server/internal/service/session/archive_preflight_order_test.go) checks lower work and returned transaction completion before the finisher, preserving outcome and error identity.
- Core witnesses retain [preflight before residency](../../../../packages/daynight-server/internal/core/session/archive_preflight_order_test.go) and [terminal initial-delivery state and proposed writes](../../../../packages/daynight-server/internal/core/session/terminal_initial_delivery_witness_test.go).
- Store witnesses retain [failed-disconnect rollback and its cause](../../../../packages/daynight-server/internal/core/store/postgres/session_scope_test.go), [return of the only physical connection](../../../../packages/daynight-server/internal/core/store/postgres/session_scope_test.go), and [zero legacy content rows after native ledger writes](../../../../packages/daynight-server/internal/core/store/postgres/session/operation_contract_test.go).
- The [Attachment HTTP witness](../../../../packages/daynight-server/internal/server/attachment/body_completion_socket_test.go) retains consumed-body metadata failure and next-request keepalive through direct lower calls and actual TCP.

`TestServerAPISessionNormalFlow` uses the real production Server, authentication,
PostgreSQL and WebSocket connections for owner-bound Worker claim, Session
registration/grant, Controller hello/synchronization, current-state and browser
snapshot identity, and exact timeline content delivery. The integration runner
selects it alongside `TestServerAPINormalFlows`; these are sequential normal
flows, separate from unit fault and concurrency matrices. The
[server guide](../../../../packages/daynight-server/README.md#session-http-tests)
owns commands and resource boundaries.

## Alternatives

**Keep complete application, schema and login fixtures.** They supply valid
prerequisites but couple HTTP feedback to database, gateway and unrelated
resource setup. Physical mechanisms and normal assembled flows have their own
required witnesses.

**Mock DAO results while executing real Session service and engine logic.**
This continues to execute lower business rules inside HTTP tests and does not
isolate the adapter responsibility required by the common test policy. Direct
typed use-case callbacks retain actual routing and transport while giving
service, Core and Store observations their own owners.

**Use a generic in-memory Session ledger.** Reproducing state transitions,
queries, persistence and rollback would create another business implementation.
A passing mock response could hide a caller or backend defect. Explicit lower
results and request assertions expose the dependency instead.

## Consequences

The complete regular Session HTTP selection runs without database or UniAuth
fixture configuration. Its feedback covers routing, credential policy, frames,
body/socket behavior, cancellation, drain and capability release. Business
rules, transaction completion, physical SQL and normal full-application behavior
retain separate executable owners.

Tests must supply valid reply projections and declare each call or channel tick
relationship they depend on. Pre-welcome source sequence, synchronization,
first-input and background disconnect remain explicit cases. Changes to a
public operation require checking its HTTP argument/result mapping and its
lower proof owners. A successful mocked outcome does not establish persistence
or business state.

Source-bound validation artifacts retain runtime measurements and fault
comparisons. Package timings alone do not measure whole-job improvement; the
full Go check and API runner retain their existing gates and resource cleanup.
