# Agent Note: Webhook Service DAO Mocks

Status: implemented

## Problem

Webhook configuration, capture, delivery and retention tests obtain business
records through fresh PostgreSQL schemas and repeatedly execute source writes,
HTTP delivery, clock expiry and cleanup. These mechanisms obscure which layer
owns a failed rule and impose database setup and real-time waiting on ordinary
service changes. Several matrices also combine business decisions with SQL,
protocol and process observations, so replacing their database fixture alone
would lose independent integration oracles.

The earlier [fixture construction decision](2026-11-08-go-fixture-construction.md)
reduced redundant schema construction while preserving isolated source rows.
That choice addressed setup cost within a mixed matrix; it did not separate
service rules from persistence contracts.

## Decision

The Webhook service suite uses the existing `core/store` transaction, scope and
DAO interfaces with explicitly configured domain records and outcomes. Mocks
record requested writes and return separately configured projections; they do
not implement a second database or derive committed state from an observed write.
Unexpected methods, parameters or calls fail the test. Transaction callback
errors, commit outcomes and cleanup failures remain distinct, including unknown
outcomes that cannot be interpreted as rollback.

Configuration and redelivery cases own authorization, versions, budgets,
idempotence, fresh observations and effect parameters. Capture cases own frozen
audience grouping, immutable facts and responsibilities, schedule generation and
error propagation. Delivery and retention cases own admission, finalization,
recovery, reconciliation and lifecycle decisions from DAO results. Time-dependent
rules receive explicit `ObservedAt`, `RecordedAt` and Fact times.

Concurrent mock calls synchronize actual callback entry and cancellation through
channels. Ordering belongs to a logical worker, delivery or transaction, or to
an explicit cross-operation barrier. An unexpected asynchronous call marks the
test failed independently of a panic that the runtime may recover. Cleanup
cancels and drains blocked work. Production polling, transaction and retention
defaults remain unchanged; narrow test budgets preserve the distinction between
an internal deadline and caller cancellation.

Task, Step, Thread and Worker producers own Fact construction and Capturer
invocation. PostgreSQL tests own real source/capture and multi-record atomicity,
operation fences, actor and credential reads, lease and retention locking,
acknowledgement loss and fresh-process durability. The server check selects the
`webhooktest` Runner witness explicitly for abrupt committed claim/admission,
post-TLS pre-finalize exit and discarded finalize acknowledgement followed by an
enabled restart. This preserves its ordinary CI signal without enabling the
other test-build matrices or production-duration stress cases. They exercise DAO contracts
directly rather than hosting the removed service matrices. HTTP adapters own
request parsing, identity, response codes and diagnostics; protocol and transport
owners retain authentication, exact bytes, TLS and response-reading boundaries.

The [server test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns standalone execution and the full module gate. Source-bound measurements
and fault observations belong to delivery artifacts, rather than this decision.

## Alternatives

**Keep PostgreSQL in the service matrices and shorten polling.** It retains
schema, seed, query and cleanup dependencies and still mixes rule decisions with
storage behaviour. Real SQL and lock tests remain necessary, but their owner is
the PostgreSQL implementation.

**Share a mutable schema across all service tests.** It adds reset and lifecycle
coupling, especially for injected triggers, unknown commits and concurrent work.
Narrow DAO fixtures express the required records without a shared persistence
simulator; physical mutation tests retain their own isolated schemas.

**Use a permissive success stub or an in-memory database.** A success stub can
skip callbacks or hide unexpected access. A database simulator duplicates state,
transaction and query semantics and can validate a service against the wrong
storage behaviour. Explicit callbacks, records and outcomes expose the contract
without reproducing SQL.

**Move complete service workflows into DAO or end-to-end suites.** This transfers
the repeated work while making those layers responsible for business matrices.
Only the independent SQL, protocol and process observations move to their
owners; service decisions remain locally executable.

## Consequences

Ordinary Webhook service tests execute without a database URL and report the
specific DAO decision, parameter or outcome that failed. Their assertions cannot
claim actual persistence or rollback, so corresponding SQL and transaction
oracles remain required. New tests document this split explicitly.

Mock-heavy coverage is meaningful only when callbacks run, unexpected access
fails and representative contract faults are detected. Package coverage and a
passing suite do not alone prove preserved integration behaviour or faster CI.
Performance comparisons retain matching workload, toolchain, cache and resource
conditions, and distinguish case, package and hosted job results.
