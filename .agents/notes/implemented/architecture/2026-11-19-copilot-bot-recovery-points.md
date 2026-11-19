# Agent Note: Copilot Bot Recovery Points

Status: implemented

## Problem

A Copilot native Session ID cannot recover a conversation after its shared
session directory is removed. Preserving only the event log omits SQLite,
checkpoints and other session resources. Copying while native writes continue
can capture an inconsistent state, and restoring an older point after an
unknown operation can repeat an external effect.

## Decision

New dedicated Copilot Bot tickets bind a private recovery database and immutable
snapshots under `bots/<botId>/native/copilot/`. The original `COPILOT_HOME`
continues to resolve account configuration, authentication, tools and repository
hooks. The verified profile is SDK 1.0.11 with actual CLI 1.0.105; a launcher
version alone cannot establish the version of a runtime using `--no-auto-update`.

The Provider retains its current turn until native work and queues are empty,
the native `sessions.save` operation has flushed pending writes, and the
session directory has a verified snapshot. SQLite databases use online backup;
source inventories before and after copying detect changes. Native execution
locks are excluded by their specific names. Snapshot validation requires the
original input identity, terminal assistant output and complete tool results.
The execution must still be current immediately before the manifest commits.

Native startup, resume, input and setting dispatch first commit a dirty barrier
using SQLite DELETE journals with EXTRA synchronization. Unknown results fence
further input. A later event or configuration response cannot clear that fence.
Settings without a following successful turn remain unprotected. Concurrent
steering is rejected so one turn cannot certify another unfinished operation.

Recovery preserves the original service, owner, Bot, platform Session, native
ID, cwd and configuration root. It rejects dirty state, missing material,
unsupported versions and conflicting native files. An existing directory is
never replaced; only a matching snapshot and recognized shutdown-event suffix
are accepted. A missing directory is created exclusively and populated with
exclusive file copies, then verified before native startup. Partial publication
blocks startup and retains the snapshot. This is intentionally not described
as an atomic directory rename on every platform.

The [Worker design](../../../../docs/design/worker-bot-runtime.md#copilot-原生恢复点)
owns the current storage and lifecycle behavior.

## Alternatives

**Use a private COPILOT_HOME.** This relocates configuration as well as session
state. Copying selected account files cannot establish equivalent authentication,
skills, plugin and hook discovery, and copying the entire home exceeds Bot
ownership.

**Implement SDK SessionFs.** Real same-ID recovery and tools can use its file
and SQLite callbacks, but CLI 1.0.105 rejects filesystem repository hooks with
that provider. Omitting the option skips those hooks. A partial search for hook
files cannot establish compatibility with inline settings and additional
directories. Preserving the original native storage avoids that configuration
change and the additional filesystem protocol implementation.

**Copy after an idle event alone.** Idle is not a persistence receipt. Native
save, activity checks, stable source inventories, SQLite backup and event
closure are separate conditions; failure of any one preserves dirty state.

**Restore a successful point after every failure.** A failed or disconnected
operation may already have changed the workspace. Recovery must not interpret
missing completion evidence as permission to replay it.

## Consequences

The recovery point is a same-machine backup of native session data, not a
workspace or off-machine backup. Full-directory copies grow with history.
Compaction, subagents, autopilot and other unverified native dependencies are
rejected rather than certified by this profile. Supporting those cases requires
proving their complete resource closure and completion evidence before widening
validation; the original format must not silently acquire that guarantee.

Existing tickets retain their behavior. Bot deletion owns the private recovery
directory while shared native configuration and working files remain separate.
An unprotected empty session cannot become a newly created replacement session.
Snapshot cleanup errors preserve the distinction between a committed new point
and unfinished cleanup.
