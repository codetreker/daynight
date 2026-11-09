# Agent Note: Attachment Record Validation Isolation

Status: implemented

## Problem

Manifest, stage, receipt and path validation tests prepared PostgreSQL only to
supply a stable attachment-maintenance snapshot. Each malformed-record or
inventory branch repeated database initialization, identity and Task setup.
The behavior under test was record consistency and durable filesystem handling,
while separate tests verified PostgreSQL schema support, maintenance queries and
cross-process recovery.

## Decision

The isolation change moved five record-validation tests to the existing
`store.AttachmentMaintenance` fixture inside the migration package. Its visitor
supplied explicit database identity, Project, Task ownership and attachment
metadata facts. The fixture retained both Task and Project IDs so published
project/shard paths were checked without changing their meaning.

All 28 original branches retained their mutations, error categories, content
bytes, source/destination paths and recovery observations. Each action opened a
fresh `os.Root`, called the real migration `Run`, and preserved both the run error
and the root-close error. Planning, journal publication, file and directory
synchronization, movement, receipt validation and resume remained real filesystem
operations. The mock supplied data facts; it did not simulate PostgreSQL SQL
or filesystem execution.

The external tests for unsupported database shape and command/root failures
kept their real PostgreSQL setup and unchanged assertions. Production maintenance
snapshot tests and process crash/resume integration retained their existing
owners. Removing an unused record fixture did not replace those backend
boundaries. Focused package commands used the unit Web-resource overlay because
retained external integration tests still compiled the production composition;
rule selections themselves needed no database URL.

The [old-layout compatibility removal](../simplification/2026-11-09-remove-attachment-layout-migration.md)
retires the converter, maintenance contract and all dedicated tests. This record
preserves the original isolation decision and its proof boundaries. The
[server test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the continuing shared DAO mock policy.

## Alternatives

**Keep PostgreSQL for every record mutation.** It supplied the same stable
snapshot repeatedly but added no different oracle for malformed JSON, unsafe
paths or receipt consistency. Dedicated backend tests retained actual schema and
snapshot guarantees.

**Mock the migration runner or filesystem.** This would have stopped proving real
journal writes, directory synchronization, source-byte preservation and resume
behavior. The real runner and temporary filesystem remained in every branch.

**Replace the external fixture globally.** Database-shape and command/root
proofs needed to reach the actual maintenance connection and adapter. Only the
five record/filesystem tests moved to the internal data fixture.

## Consequences

Record validation stopped repeating 28 PostgreSQL setups while retaining all
original filesystem operations and observations. Those cases could execute
without a database URL, but still depended on native filesystem semantics and
retained meaningful permission, path and synchronization failures.

Representative regular-file validation faults were checked against both the
original and isolated receipt tests through per-command overlays. Scoped
measurements described feedback cost only; the full module still ran real
integration tests. Source-bound records own any whole-job performance claim.
The later capability removal ends these tests' production responsibility without
changing the distinction between mocked data facts and real owned mechanisms.
