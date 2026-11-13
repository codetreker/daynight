# Agent Note: SQL Session content and stopped maintenance components

Status: implemented

## Problem

Immutable body candidates retain every revision even though a Session exposes
only each entry's current content. Deleting candidates without excluding old WAL
snapshots can invalidate an earlier reader. Moving current bodies into SQLite
also leaves historical free pages and WAL bytes behind, so a successful logical
conversion alone cannot restore normal physical admission.

## Decision

The SQL content store keeps one validated current row per entry and maintains
current count and UTF-8 JSON bytes in the original writer transaction. Sequence
and revision values retain signed 64-bit precision, and reads verify the complete
stored identity and content. Pagination queries only the requested rows; explicit
full traversal consumes the statement synchronously inside its caller's read
transaction. The resource composition guards deletion with current SQL and native
input image references before delegating leases, pins and files to the existing
[resource owner](2026-11-12-session-resource-files.md).

Historical conversion and post-commit maintenance are callable components. They
were delivered independently with a staged SQL resource outside numbered version 9
discovery, allowing their full mechanisms to be validated before ordinary consumers
changed. The [activation decision](2026-11-12-session-sqlite-activation.md) adopts
that unchanged resource as canonical 010 and connects all consumers through the
existing schema-snapshot and validation owner. There is one format path and one
body authority.

Conversion preserves the original execution, operation, provenance and stopping
evidence. Only committed pointers determine current content. Source export and
SQL import share the original permit and a local peak reservation, allowing
otherwise valid history whose obsolete candidates exceed normal metadata
admission to be reclaimed. The existing per-execution, state-directory and free
space limits continue to apply.

Stopped maintenance retains ownership through reader barriers, recognized source
retirement, in-place VACUUM, a post-VACUUM TRUNCATE checkpoint, actual file and
content verification, pending-clear readback and reservation settlement. Before
unlinking old bodies, the resource owner durably clears only the shared legacy
index's body references and preserves its complete resource inventory. Publishing
the index and retiring files are ordered recovery phases: a failed publication
retains files, and reentry confirms the publication again before resuming deletes.
A new SQL reader which captured the old index may reread one provably changed
inventory; unchanged or still-referenced missing files continue to fail. The
resource owner never caches legacy references for later inventory writes or
rollback. A busy reader retains the files, pending flag and required reservation. Failures preserve
the actual committed phase; the ledger replaces the execution's absolute charge
from observed remaining work rather than accumulating refunds. The
[component design](../../../../docs/design/session-sqlite-content.md) owns the
interfaces, ordering, budgets and recovery behavior. The
[storage ownership decision](2026-11-12-controller-storage-ownership.md) continues
to own permits, role admission and process evidence.

VACUUM runs synchronously on the original connection while the original permit
remains held. Its scope temporarily sets `SQLITE_TMPDIR`, `TMPDIR`, `TEMP` and
`TMP` to a verified private directory on the journal volume, then restores each
variable's exact prior presence and value. The directory is checked for private
identity, write access and Unix search access before entering that scope. SQLite
calls in this process run synchronously on one JavaScript thread; the existing
Markdown parser worker does not use SQLite. Introducing concurrent SQLite threads
requires reconsidering this environment scope.

The shipped better-sqlite3 build uses SQLite 3.54.1 with `TEMP_STORE=1`,
`DEFAULT_WORKER_THREADS=0` and
[`SQLITE_OMIT_DEPRECATED`](https://github.com/WiseLibs/better-sqlite3/blob/0d704b07468d7a8d993badce89cf2b0fbfb8dda1/deps/defines.gypi#L33).
The [Unix VFS](https://github.com/WiseLibs/better-sqlite3/blob/0d704b07468d7a8d993badce89cf2b0fbfb8dda1/deps/sqlite3/sqlite3.c#L46919-L46943)
checks the environment and directory access for each temporary filename. The
[native Windows VFS](https://github.com/WiseLibs/better-sqlite3/blob/0d704b07468d7a8d993badce89cf2b0fbfb8dda1/deps/sqlite3/sqlite3.c#L53452-L53468)
calls `GetTempPathW` each time; that API checks
[`TMP` before `TEMP`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-gettemppathw).
It does not validate directory access, making our directory checks necessary.
The [SQLite temporary-file policy](https://www.sqlite.org/tempfiles.html#temporary_file_storage_locations)
explains the built-in VFS selection. Linux tracing verified new private locations
after SQLite was already in use; that observation supplements the source contract
and does not substitute for native platform CI.

## Alternatives

**Continue immutable body candidates.** This preserves cheap publication but
retains obsolete revisions until a separate retirement mechanism establishes
reader safety. Frequent revisions therefore consume space unrelated to current
history size.

**Delete candidates immediately after SQL import.** An existing v8–9 read
snapshot can still reference its committed candidate. An explicit successful
TRUNCATE checkpoint proves that snapshot has ended before files are retired.

**Treat VACUUM success or logical page counts as reclaimed disk.** WAL-mode
VACUUM can leave compacted pages in WAL while another connection remains open.
Only the post-checkpoint file measurement can establish physical admission.

**Enable the new format before adapting its consumers.** Readers, writers,
resource guards and archive traversal must agree on one body authority. Keeping
the completed components outside numbered production discovery allowed that
adoption to remain one focused change.

**Run VACUUM in a child with private temporary environment.** If the parent
exits before the child, PID-based permit takeover can admit a new writer while
the orphan still runs or is about to begin VACUUM. Running on the owning process's
original synchronous connection preserves the same lifetime as the permit.

**Use `temp_store_directory` or `temp_store=MEMORY`.** The deprecated directory
pragma is omitted by the shipped build and changes process-global state with TEMP
schema side effects. Connection-local memory storage avoids disk temporary files,
but adds a potentially large RAM peak and changing it deletes TEMP objects. The
selected disk peak policy retains file-backed compaction and scopes the existing
built-in VFS directory lookup.

## Consequences

Current body storage and statistics no longer grow with replaced revisions in the
SQL component. Migration and maintenance remain separate outcomes: SQL history
can be readable while cleanup is pending and ordinary writer admission waits.
SQLite busy timeouts bound lock waiting, and deadlines are checked before and
after synchronous phases. A JavaScript timer cannot interrupt native VACUUM;
expiration after it returns preserves the completed phase and pending allocation.

This adds explicit physical peak accounting and maintenance sequencing without
changing Session protocols, resource paths, input origins or native execution.

The production journal uses these components through the original
role-specific preparation entry. Generated stress data documents its own content and operating conditions; absent
original incident bytes, it cannot establish exact incident replay or an
equivalent performance result.
