# Agent Note: In-Memory SQLite Unit Tests

Status: implemented

## Problem

Business-state tests repeatedly created SQLite files even when their assertions
concerned SQL constraints, transitions and transaction rollback within one
connection. File creation and journal synchronization added storage work to
those cases. Persistence, filesystem identity and cross-process coordination
also had existing coverage, so treating every database open as an independent
memory database would remove the shared state those regressions observe.

## Decision

Business-state unit fixtures create private native `:memory:` connections through
`test/helpers/sqlite.ts` and supply them explicitly to their stores. The same SQL,
format checks, migrations, startup callbacks and transaction boundaries execute
against SQLite. A fixture uses its original connection for direct SQL assertions;
each case owns its connection and closes it during cleanup.

`SqliteDatabaseSource` accepts an absolute filename or an existing native
connection. Filename opens preserve WAL, FULL synchronization and the existing
filesystem, maintenance and shutdown rules. Supplied writable opens take
ownership of the connection and use its actual storage mode: an in-memory
connection uses MEMORY journaling, while a file connection requires WAL. A
successful store owns shutdown; initialization failures retain the access
layer's reported transaction and connection outcomes.

A supplied read connection is borrowed. The caller owns migration exclusivity
and final shutdown. The reader temporarily enables `query_only`, checks the
format and reads within one deferred transaction, then restores the previous
setting. Required migration uses the same connection and preserves its owner's
ability to inspect rollback after failure. This connection path does not infer a
missing file or acquire a filesystem maintenance permit.

Controller fixtures retain a filename for their separate pending-content source
and supply the database connection through the lifecycle-store options. Startup
ownership checks and content reconciliation remain inside the original migration
transaction. In-memory SQLite does not imply that Git fixtures, IPC or pending
archive content stop using their real files.

Cases proving reopen persistence, WAL snapshots, separate live connections,
filesystem errors or identity, instance locking and cross-process recovery live
in explicitly named integration suites. Both `*.test.ts` unit suites and
`*.integration.test.ts` suites remain selected by ordinary `pnpm test` and the
existing native-platform CI checks. The
[development guide](../../../../docs/development.md#cli-development) owns commands;
the [SQLite design](../../../../docs/design/cli-sqlite-migrations.md) owns the
connection mechanisms. The
[format-migration decision](../../archived/architecture/2026-10-30-cli-sqlite-migrations.md)
records the rationale for conversion and file maintenance. The
[archived Git validation decision](../../archived/testing/2026-10-18-parallel-git-validation.md)
records the original private-fixture structure; its per-case database ownership
continues with memory connections.

## Alternatives

**Replace every constructor globally with `:memory:`.** Each native memory
connection is a different database, and closing it destroys its state. This
would break independent readers, reopen checks and process coordination. Faking
WAL results, ignoring close or silently serializing state would make those tests
accept behavior that the production file lifecycle rejects.

**Keep file databases for every case.** This retains the existing proof but
continues paying filesystem and journaling costs for cases whose assertions are
fully observable through one native connection. Explicit connection sources
preserve those SQL and transaction assertions without that storage work.

**Put all fixture files on a RAM filesystem.** This can preserve file semantics
while reducing physical storage traffic, but requires platform-specific mount
and cleanup tooling. It also retains filename, journal and filesystem operations
for unit cases. Native memory connections provide the required unit-test
storage without adding operating-system infrastructure.

## Consequences

Unit fixtures avoid SQLite database files and their journal synchronization while
retaining native SQL and transaction failures. File-specific integration tests
continue to exercise actual storage and process boundaries under the same
ordinary quality gates. Production entrypoints still select absolute filenames.

Connections cannot be shared across cases, retained after their owning store
closes, or reused as evidence of persistence after shutdown. New cases that need
another process or a separate live database connection belong with the file
integrations. Passing memory tests does not establish WAL, crash recovery or
native-platform behavior, and reduced file work alone does not establish a
measured whole-job speedup.
