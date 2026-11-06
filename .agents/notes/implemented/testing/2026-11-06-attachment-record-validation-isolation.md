# Agent Note: Attachment Record Validation Isolation

Status: implemented

## Problem

Manifest, stage, receipt and path validation tests prepared PostgreSQL only to
supply a stable attachment-maintenance snapshot. Each malformed-record or
inventory branch repeated database initialization, identity and Task setup.
The behavior under test is record consistency and durable filesystem handling,
while separate tests verify PostgreSQL schema support, maintenance queries and
cross-process recovery.

## Decision

Five record-validation tests use the existing `store.AttachmentMaintenance`
fixture inside the migration package. Its visitor supplies explicit database
identity, Project, Task ownership and attachment metadata facts. The fixture
retains both Task and Project IDs so published project/shard paths are checked
without changing their meaning.

All 28 original branches retain their mutations, error categories, content
bytes, source/destination paths and recovery observations. Each action opens a
fresh `os.Root`, calls the real migration `Run`, and preserves both the run error
and the root-close error. Planning, journal publication, file and directory
synchronization, movement, receipt validation and resume remain real filesystem
operations. The mock supplies data facts; it does not simulate PostgreSQL SQL
or filesystem execution.

The external tests for unsupported database shape and command/root failures
keep their real PostgreSQL setup and unchanged assertions. Production
maintenance snapshot tests and process crash/resume integration remain in their
existing owners. Removing an unused record fixture does not replace those
backend boundaries.

The [server test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the shared DAO mock policy. Focused package commands use the documented
unit Web-resource overlay because retained external integration tests still
compile the production composition; rule selections themselves need no
database URL.

## Alternatives

**Keep PostgreSQL for every record mutation.** It supplies the same stable
snapshot repeatedly but adds no different oracle for malformed JSON, unsafe
paths or receipt consistency. Dedicated backend tests retain actual schema and
snapshot guarantees.

**Mock the migration runner or filesystem.** This would stop proving real
journal writes, directory synchronization, source-byte preservation and resume
behavior. The real runner and temporary filesystem remain in every branch.

**Replace the external fixture globally.** Database-shape and command/root
proofs must continue to reach the actual maintenance connection and adapter.
Only the five record/filesystem tests move to the internal data fixture.

## Consequences

Record validation no longer repeats 28 PostgreSQL setups, while all original
filesystem operations and observations remain. These cases can execute without
a database URL, but still depend on native filesystem semantics and retain
meaningful permission, path and synchronization failures.

Representative regular-file validation faults are checked against both the
original and isolated receipt tests through per-command overlays. Scoped
measurements describe feedback cost only; the full module still runs real
integration tests and source-bound records own any whole-job performance claim.
