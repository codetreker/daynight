# Agent Note: MCP Transfer Test Ownership

Status: implemented

## Problem

Private-transfer service tests repeatedly prepared PostgreSQL, identities,
Projects, Tasks and attachment services to obtain facts for lifecycle and upload
coordination. Their failures mixed service decisions with SQL, persistence and
lower attachment behavior. The same package contained pure JSON-binding cases
and a cross-process orphan-recovery witness, so replacing its database fixtures
without separating those responsibilities would lose meaningful detection.

A receipt returned by a mock cannot establish that its reservation and record
committed together. A lease or database result also cannot prove that a live
writer has released a filesystem gate or that a restarted process reclaimed its
unreceipted object.

## Decision

The complete `internal/service/mcptransfer` suite uses strict expectations on the
existing private-transfer DAO and transaction contracts. Expected query results,
proposed writes and completion outcomes are configured independently. Expected
record data is copied independently of the operation's mutable input; captured
writes never produce later reads or implement an evolving database. Unexpected
or missing calls fail, and transaction callback execution remains distinct from
`committed`, `not_committed` and `unknown` completion.

Uploads control the directly invoked attachment operation. The private
`Uploads.admitTransfer` adapter is instance-owned and returns the narrow
`transferAdmission` capability used by commit. `NewUploads` initializes it to
delegate to the original attachment service's `AdmitTransfer`; its public signature
and production renewal interval remain unchanged. Tests supply that lower
operation's result, error and cleanup behavior without executing a second
attachment business matrix or adding a public test API.

The actual Lifecycle, permits, private files and gates, cancellation and drain,
lease renewal, chunk stream and hash verification remain in the service tests.
The original 5 MiB file is still consumed as ten 512 KiB chunks, and inline
512 KiB plus excess-input boundaries remain real. Final attachment publication
is a separate lower operation: a supplied success, file-effect error or unknown
completion describes its outcome, not observed target persistence. The service
suite clears database and UniAuth test variables before execution.

Physical and pure proofs follow their implementation owners:

| Owner | Retained proof |
|---|---|
| [Private-transfer PostgreSQL tests](../../../../packages/daynight-server/internal/core/store/postgres/private_transfer_test.go) | Receipt/reservation/final Put atomicity, failed final Put rollback, persisted record version/data and ledger values, access replacement under the same OAuth Grant, actual revocation and late receipt/lease persistence |
| [Project deletion scopes](../../../../packages/daynight-server/internal/core/store/postgres/project_deletion_coverage_test.go) | Both orderings of `LockProjectLifecycle` and Project deletion, actual database blockers, receipt/accounting readback and private object bytes or absence |
| [Attachment lifecycle witnesses](../../../../packages/daynight-server/internal/core/store/postgres/attachment_lifecycle_witnesses_test.go) | Real Task/Project final-publication barriers, metadata retention and transaction rollback after external file effects |
| [Core binding tests](../../../../packages/daynight-server/internal/core/mcptransfer/json_test.go) | Exact large integers, structured JSON equivalence and billion-scale exponents; the extreme-exponent case runs the real implementation in a subprocess bounded to five seconds |
| [Cross-process recovery](../../../../packages/daynight-server/cmd/daynight-server/mcptransfer_recovery_process_test.go) | A live child holds the real private gate around a six-byte unreceipted orphan; cleanup refusal retains pending state, reservation and object until abrupt writer exit, then fresh startup reclaims them |

`TestMCPTransferCrossProcessCrashRecovery` uses the existing `startupshutdown`
entry. Its writer is actually killed and joined. A fresh Lifecycle subprocess
runs `New` and `Start`, observes the startup maintenance pass, then reads
`state=closed` and `reserved_bytes=0`; the parent verifies the orphan is absent.
This proves the process and cleanup mechanism with isolated PostgreSQL and real
files. Normal API integration retains its normal assembled flows without taking
over this fault scenario. The core exponent subprocess remains a pure-algorithm
bound in ordinary module validation.

The [test-writing rules](../../../../docs/writing_tests.md) own layer isolation.
The [private transfer lifecycle decision](../architecture/2026-11-06-private-transfer-lifecycle.md),
[upload deletion barrier](../architecture/2026-11-06-upload-deletion-barrier.md)
and [resumable upload decision](../architecture/2026-11-06-resumable-mcp-upload.md)
retain production contracts and their original rationale. The
[MCP protocol decision](2026-11-09-mcp-use-case-test-ownership.md) owns the direct
protocol/use-case boundary. The
[server guide](../../../../packages/daynight-server/README.md#mcp-transfer-service-tests)
owns focused commands and the existing module and startup/shutdown gates.

## Alternatives

**Retain complete database and attachment fixtures for service branches.** They
supply valid stored state, but repeat schema and lower business work for
coordination that can use explicit collaborator facts. The real backend remains
required for atomic receipt/accounting and persisted authority observations.

**Replace files, gates or the process witness with returned outcomes.** A mock
cannot establish exclusion while a writer lives, private byte cleanup, actual
stream consumption or recovery after abrupt exit. Those mechanisms retain their
native resources in the service or process owner.

**Move entire service scenarios to Store or normal API integration.** This would
retain the lower business matrices and their setup under a different directory.
Direct Store witnesses preserve physical facts, while the separate process
entry preserves the existing crash phases without expanding normal flows.

## Consequences

Service feedback executes without PostgreSQL or authentication fixture setup.
Its real lifecycle and resource assertions remain executable; SQL atomicity,
locks and persisted readback stay with Store, binding equality with core, and
cross-process orphan recovery with the existing lifecycle entry. Production
capacities, timing defaults and quality gates retain their existing contracts.

Performance comparisons include the service suite and the receiving core,
Store and process work under matching toolchain, instrumentation, caches and
resource limits. Removed fixture cost is distinct from moved physical work.
Source-bound validation owns samples, fault controls and hosted observations;
a shorter package time alone does not establish lower complete-command or CI
completion time.
