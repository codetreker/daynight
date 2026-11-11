# Agent Note: Persist explicit settings before an empty Codex thread becomes ready

Status: implemented

## Problem

Codex can acknowledge an explicit model and effort at thread startup without
persisting those choices for a thread that has never received user input. A
cold resume then keeps the original thread identity but resolves different
settings. Reapplying startup configuration during resume would overwrite later
settings that the user changed inside the native conversation.

The metadata check must also distinguish the original database from a
replacement at the same path. Default numeric filesystem stats cannot represent
every 64-bit file ID exactly, so distinct live file objects can share the same
rounded identity and incorrectly confirm another database's committed row.

## Decision

The shared Codex Provider materializes the empty rollout through its existing
`thread/read(includeTurns: true)` call, then persists only explicitly requested
initial model and effort with one `thread/settings/update`. This ordering is
required by the observed Codex 0.167.0 behavior: an update before the read does
not retain the selection after a cold resume. An empty-thread read may perform
the persistence side effect and still return a native history error. For
explicit initial selections, only code `-32601` with the exact message
`list_turns is not supported yet` is accepted as that compatibility case.
Other read errors stop initialization before updating settings. Calls without
explicit selections retain the prior native-read compatibility behavior.

A same-value update can acknowledge with `{}` without emitting a settings
notification, and the RPC reply precedes core processing and rollout writes.
Initialization therefore validates the receipt and then waits for a new,
complete `thread_settings_applied` record in the original native rollout.
The reader binds the native-provided path, home, thread ID and real working
directory before dispatch; only appended records after that baseline count.
It compares explicit fields against the already validated effective model
(or the explicit request when startup selection validation is disabled) and
requested effort. It never writes history or promotes a display fallback.

The initial rollout observation established that the settings event survived a
process crash, but native metadata synchronization occurs after that append.
Another native client can read the empty thread and establish an older SQLite
row first. Killing the writer after the JSONL event but before metadata commit
then lets cold resume use the stale row. The same initialization decision
therefore requires both the new rollout record and committed resume metadata.

The metadata reader resolves managed `sqliteHome`, effective `sqlite_home`,
the actual child's `CODEX_SQLITE_HOME`, and native home in priority order. It
supports the verified `state_5.sqlite` layout rather than scanning for a likely
database. The first existing ordinary file binds the canonical path and exact
`bigint` device and inode values. Every observation uses `lstat` with
`bigint: true` before and after its SQLite read, checking the original identity
and canonical path at both boundaries. It opens a read-only, file-must-exist
connection with zero busy timeout, selects the original ID, path, cwd and both
settings in one row, then closes the connection. Only explicit fields constrain
settings. WAL remains visible; no transaction spans polls and no native database
is created, migrated, checkpointed or written. A missing database before identity
binding, missing rows and unmatched values wait within the shared deadline;
unsupported schemas, corruption, nonfiles and identity changes fail. A bound
path disappearing also fails. JSONL is checked again after metadata confirmation.

Exact stat values are required by the filesystem representation, not by SQLite:
Node's Windows adapter exposes the
[64-bit file ID as the inode](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/fs.c#L1971),
then [converts stat fields to the selected numeric type](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/src/node_file-inl.h#L89).
The [default Float64 stat array](https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/src/node_file.h#L78)
loses integer precision above the safe-integer range. Requesting bigint stats
preserves file identity without changing a stored format or public API.

The rollout reader uses one file handle, checks replacement and truncation,
and bounds bytes. Configuration reads, the single update and both persistence
observations share one deadline. Partial records cannot confirm readiness. Native
errors, disconnect, invalid records, unconfirmed persistence and timeouts
close the owned process. No update, input or new thread is automatically
retried. The already observed native identity remains available to the
existing recovery owner.

The protocol rationale is pinned to Codex commit
`086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`: the
[update handler](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/turn_processor.rs#L973)
acknowledges the queued operation before core processing;
[notification deduplication](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/bespoke_event_handling.rs#L1300)
suppresses unchanged settings; and
[cold resume](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/thread_processor.rs#L4593)
also reads SQLite metadata for model and effort. The
[live append](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/thread-store/src/live_thread.rs#L229)
finishes the rollout write before updating that metadata. The
[settings operation handler](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/session/handlers.rs#L626)
produces the applied event; fresh startup does not independently submit this
operation. The initializer owns the only settings write before returning the
Provider handle, so a matching record after its baseline can acknowledge this
single update without an operation ID. This assumption must be revisited if
initialization gains another settings writer or the native event source changes.

Omitted fields remain omitted. Resume continues to read the native settings
without injecting frozen initial choices, preserving the authority described
by the [Worker override decision](../architecture/2026-11-06-worker-local-native-overrides.md).
The [shared requirements](../../../../docs/spec/task-sessions.md#启动结果与恢复阻断)
and [protocol design](../../../../docs/design/task-session-protocol.md#codex-初始设置持久化)
own the current contract and mechanism.

## Alternatives

**Reapply frozen choices on every resume.** This repairs an untouched thread by
overwriting subsequent user settings, losing native conversation authority.

**Update immediately after startup.** The empty rollout has not yet been
materialized, so the acknowledged update does not establish cold persistence.

**Use the interactive controls setter.** Same-value initialization need not
produce the notification that this path requires, causing a false timeout.

**Accept every native read error before updating settings.** A denied rollout
write can be followed by a successful `{}` settings receipt, while a cold
resume still fails because the rollout is missing. Broad read compatibility
would therefore falsely confirm durable explicit settings.

**Treat RPC acknowledgement or another live read as durable completion.**
The native update is queued before the acknowledgement; a subsequent read can
still return live configuration while the persisted settings event is absent.
Neither another live read nor the original rollout's new record proves that
SQLite has committed: live reads overlay runtime settings, and JSONL precedes
metadata synchronization. Direct read-only observation confirms the stored row
without adding another native mutation or restarting the production thread.

**Persist resolved defaults too.** That would freeze values the caller omitted
and turn display fallbacks into user intent.

**Keep numeric file identity.** Comparing rounded device and inode values can
accept distinct 64-bit identities, even while the original database still
exists. Converting those rounded values to strings or bigint afterward cannot
recover the discarded bits; both stat observations must request exact values.

## Consequences

Explicit fresh choices add one settings RPC, two configuration reads and
bounded observations of the original rollout and SQLite row before readiness. Native versions that reject the operation or expose
an unsupported persistence format fail visibly instead of claiming durable
settings. A missing or unavailable SQLite database no longer permits explicit
fresh choices to report ready solely from JSONL, even if a particular native
recovery could rebuild it. Resume and omitted initial choices gain no such
dependency. The dual barrier supports process-crash recovery, not a guarantee
of durability across power loss.
Fixture tests cover request ordering, omission, unchanged resume and failure
cleanup. Real SQLite and filesystem tests cover committed snapshots, locks,
replacement, symlinks, corruption and row ownership. A focused regression
controls only stat IDs to distinguish `2^53` from `2^53 + 1`, whose numeric
representations are equal, and rejects both device and inode changes between
polls and across one SQLite read. These controlled IDs establish the precision
boundary independently of the filesystem's allocated IDs; they do not measure
the IDs assigned by a particular platform run. Native-version evidence is still
required to establish actual cold persistence. The change does not repair
historical threads whose original choices were never persisted, change
interactive controls confirmation, or weaken the existing identity and
stop-proof gates for recovery.
