# Agent Note: Claude Bot Recovery Points

Status: implemented

## Problem

A Claude Bot loses its native conversation when shared transcript files are
removed. A native ID alone cannot restore that history. Isolating the entire
Claude configuration directory changes account settings, authentication and
tool discovery, while resuming an older transcript after an unknown command
can repeat an external effect.

## Decision

New dedicated Claude Bot tickets bind a private SQLite mirror under
`bots/<botId>/native/claude/`. The SDK session store receives native entries
after their local write and drains pending mirror writes before publishing a
result. The adapter uses this boundary on SDK 0.3.247 with its native CLI
2.1.247. Persistence failures remain fatal even though the SDK itself retries
and eventually continues after a mirror error.

Native startup, resume, input and setting changes first persist a dirty barrier. A successful
result protects its input identity only after the mirror contains the turn's
records. The protected point includes the original service, owner, Bot,
Session, native ID, cwd, configuration root, versions and content digest.
Unknown, interrupted or failed turns cannot clear the barrier. Confirmed idle
settings remain dirty until a later successful turn supplies a flush boundary.
SQLite uses DELETE journals with EXTRA synchronization so the journal directory
is synced after commit; FULL alone can lose the last dirty transaction after
power loss on some filesystems. An unconfirmed setting failure fences further
native dispatch and protection even if the underlying setter later completes.

Recovery validates the mirror and original stopped execution. It recreates a
missing native transcript through atomic exclusive publication; conflicting
existing content is retained and rejected. Normal account configuration stays
in its original directory. SDK `extraArgs.resume` selects the original native
ID without invoking the SDK session store's temporary-home materialization.
An unexpected store load is rejected, and an actual SDK regression tests this
version-specific argument behavior.

The profile covers a single root transcript. Concurrent steering, image input,
compaction and native dependencies outside that transcript do not have a
verified recovery guarantee. Image and overlapping input are rejected before
dispatch. Unsupported native records leave recovery blocked with their
original evidence. Account tool configuration is preserved. Broader recovery
requires validating and storing the complete additional resource set before
widening admission; it must not reinterpret the existing format as proof that
those resources were protected. An empty newly created session has no
protected conversation turn and cannot be replaced with a fresh session on
restart.

The [Worker runtime design](../../../../docs/design/worker-bot-runtime.md#claude-原生恢复点)
owns the current behavior. The
[Claude support suspension](../testing/2026-11-19-claude-support-suspension.md)
remains in effect; transcript recovery does not establish reliable macOS
initialization-disconnect cleanup.

## Alternatives

**Set a private CLAUDE_CONFIG_DIR or use SDK store-based resume directly.** The
SDK's resume materialization copies selected settings and credential files
into a temporary home. It does not preserve the complete skills, plugins and
tool discovery environment. Retaining the original configuration root avoids
silently changing account behavior.

**Copy a running transcript after observing a result.** A stable file size
alone does not prove the writer completed the turn. The SDK mirror flush
provides an explicit ordering point and propagates persistence failures to
the adapter's recovery barrier.

**Restore the last successful point after any failure.** That can repeat a
command whose result is unknown. Recovery therefore refuses dirty state
instead of assuming that missing evidence means no effect occurred.

## Consequences

Recovery is local to the same machine and verified runtime combination. It
does not back up the workspace or survive loss of the Bot's storage. Legacy
tickets retain their prior behavior. Bot deletion includes the private mirror
and retains the shared configuration home. A lifecycle repair and its macOS
validation remain necessary before restoring general Claude support.
