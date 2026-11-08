# Agent Note: Task Request and Candidate Isolation

Status: implemented

## Problem

Task input tests mixed syntax and pre-storage checks with candidate rules that
first read the current Task. A PostgreSQL fixture supplied both, and repeated
readback followed invalid updates. Replacing everything with a nil store would
miss the required read and version order; removing the storage observations would
also lose the caller's no-mutation and Project-scope guarantees.

## Decision

Service preflight tests use valid synthetic identity and Project/Task IDs with
fail-on-access storage interfaces. Create input syntax, basic Update version
and field presence, malformed identity, status input and entropy errors reject
before entering storage. Valid-input writer sentinels establish that fixtures
can reach the intended boundary when preflight succeeds.

Read-dependent update and status rules invoke `PrepareUpdate` or `PrepareStatus`
through existing `TaskWriteDAO` mocks. Stored Tasks have valid properties and
state; context, Task ID, calls and error chains are checked. Candidate refusals
perform the required Task read without an unexpected graph query or write.
Positive updates explicitly supply any empty dependency read that the real
contract requires. Stale versions retain precedence over later candidate or
no-op decisions.

Synthetic dependency IDs contain hexadecimal letters so uppercasing creates a
different spelling of the same identity. This preserves the original normalized
duplicate boundary rather than reducing it to identical strings. Original
input vectors and the entropy sentinel and cleanup remain covered.

The original mixed suite retained a PostgreSQL status-scope fixture for
representative post-read title, description and self-dependency refusals, complete
unchanged-Task readback, and missing or cross-Project tails. It also retained
all-status-pair/version, graph, rollback and concurrency observations. The later
[Task service ownership decision](2026-11-08-task-service-test-ownership.md)
separates those guarantees: non-store tests control the relevant DAO decision and
write boundary; store tests retain real SQL, locking, snapshots and rollback.
No production API or transaction simulator is introduced.

The [test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the common DAO policy. Task service tests require no database URL; physical
store tests still require an isolated PostgreSQL environment.

## Alternatives

**Keep all validation in PostgreSQL fixtures.** This repeats initialization and
state preparation for requests whose syntax already establishes refusal, and
obscures the exact reads required by later rules.

**Use nil storage for all candidate tests.** Title, description and dependency
validation can follow a current-Task read. Skipping that contract would lose
version precedence, Task facts and lookup-error behavior.

**Replace the full status matrix with mocks without retaining storage proof.**
At the time of candidate isolation, the mixed matrix owned persisted versions,
timing, unrelated fields and repeated no-op observations. Those were distinct
from candidate rules and needed real database witnesses. The later ownership
split retains their physical mechanisms in store tests.

**Drop the update-refusal readback.** A pure candidate cannot prove that a caller
obeys a refusal without a later write. The original fixture retained real caller
checks; the current split pairs an explicit service no-write oracle with store
transaction and rollback observations.

## Consequences

Preflight and candidate feedback can run independently of PostgreSQL while
retaining explicit DAO ordering and errors. The broader Task service suite now
uses the same dependency boundary. Unexpected mock access fails instead of
returning an empty default, while actual stored state and scope remain covered
by PostgreSQL tests.

Representative faults compare original and isolated rules. Scoped timings do
not establish whole-job or hosted CI savings; source-bound validation records
own performance claims and full-gate results.
