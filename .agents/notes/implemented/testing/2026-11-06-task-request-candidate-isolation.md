# Agent Note: Task Request and Candidate Isolation

Status: implemented

## Problem

Task input tests mixed syntax and pre-storage checks with candidate rules that
first read the current Task. A PostgreSQL fixture supplied both, and repeated
readback followed invalid updates. Replacing everything with a nil store would
miss the required read and version order; removing all integration assertions
would also lose the caller's no-mutation and Project-scope guarantees.

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
input vectors and the entropy sentinel/cleanup remain covered.

The existing PostgreSQL status-scope fixture also exercises representative
post-read title, description and self-dependency refusals and confirms the
complete stored Task is unchanged before its original missing and cross-Project
tail. All-status-pair/version ordering, graph SQL, rollback and concurrency
proofs remain integration tests. No production API or transaction simulator is
introduced.

The [test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the common DAO policy. Unit rule selections require no database URL; retained
integration tests still require PostgreSQL.

## Alternatives

**Keep all validation in PostgreSQL fixtures.** This repeats initialization and
state preparation for requests whose syntax already establishes refusal, and
obscures the exact reads required by later rules.

**Use nil storage for all candidate tests.** Title, description and dependency
validation can follow a current-Task read. Skipping that contract would lose
version precedence, Task facts and lookup-error behavior.

**Replace the full status matrix with mocks.** Its persisted versions, timing,
unrelated fields and repeated no-op observations are distinct from candidate
rules and remain real database proofs.

**Drop the update-refusal readback.** A pure candidate cannot prove that the
service obeys a refusal without a later write. Representative real caller
checks are retained in the existing unmodified-state fixture.

## Consequences

Preflight and candidate feedback can run independently of PostgreSQL while
retaining explicit DAO ordering and errors. The shared integration fixture
continues to protect caller state and scope, and unexpected mock access fails
instead of returning an empty default.

Representative faults compare original and isolated rules. Scoped timings do
not establish whole-job or hosted CI savings; source-bound validation records
own performance claims and full-gate results.
