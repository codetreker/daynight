# Agent Note: Codex Bot Recovery Points

Status: implemented

## Problem

A Bot's original Codex thread can disappear when shared native history is
cleaned. Keeping its thread ID or a pathname cannot restore the conversation.
Changing CODEX_HOME also changes authentication, configuration and tool discovery,
while restoring an older conversation after an unknown command can repeat an
external effect.

## Decision

New Codex Bot tickets bind `bots/<botId>/native/codex` to the original Bot and
Session. CODEX_HOME and its configuration resolution stay unchanged. The adapter
explicitly creates legacy rollout history on the verified 0.169.0 runtime.
Ordinary Tasks and existing tickets retain their previous behavior.
It names a new native thread `Daynight assistant` to materialize the otherwise
lazy empty rollout without submitting a conversation turn. Resume preserves the
original name.

Before native mutations the adapter marks a durable manifest dirty. After a
terminal turn, including compact or confirmed interruption, it copies and validates the complete rollout,
its original identity and terminal turn record, then syncs the immutable snapshot
and atomically publishes its digest and protected turn. New dispatch waits for
protection. Confirmed idle settings require a newly persisted
thread_settings_applied record. Partial records or changing sources cannot advance
the point. Native setting confirmation and recovery protection are separate
outcomes: a confirmed setting is not rolled back when snapshot publication fails.
That failure independently terminates the provider and retains the dirty barrier,
so an earlier setting receipt cannot conceal loss of automatic recovery.

Recovery requires the original execution's stop proof and storage ownership.
It verifies the same-version profile, identity and digest, marks the attempt
dirty, and copies the snapshot to a separate active file. Native thread/resume
receives the original ID and path; its returned ID, cwd and path must match.
Native resume appends to that path, so the immutable point is never its writable
target. A dirty point cannot silently restore an older conversation or replay
input.

The profile owns one legacy rollout. Forks, child-thread dependencies, external
media and unknown record formats fail protection explicitly and retain the prior
point. Embedded image bytes remain part of the checked file. It does not claim
paginated SQLite history or cross-version compatibility. The
[Worker runtime design](../../../../docs/design/worker-bot-runtime.md#codex-原生恢复点)
owns lifecycle and deletion boundaries.

## Alternatives

**Isolate CODEX_HOME immediately.** Copying selected files cannot preserve every
current authentication, managed configuration, plugin and tool lookup. Linking
the shared home would defeat data ownership. Keeping its configuration source
avoids changing these semantics.

**Copy on thread/read or unsubscribe.** These receipts do not prove the legacy
writer stopped or flushed its records. Protection requires complete on-disk
terminal evidence and a stable source copy instead.

**Resume the last good point after any failure.** This loses the distinction
between missing backup data and unknown operation effects. The dirty barrier
preserves that distinction by refusing automatic recovery until reconciliation.

## Consequences

Protected same-version legacy threads survive loss of shared conversation files
without changing credential lookup. Each protection reads and writes the rollout,
so its cost grows with native history. Parsing streams bounded chunks and rejects
records over 32 MiB without truncating them. Successful replacement removes the
previous snapshot; stopped recovery retires its previous active copy. Uncertain
publication retains files for ownership inspection.

This provider profile does not advertise complete botRecoveryVersion=1 or
independent Worker takeover. Legacy migration retains its registration and
provider verification gates. Unsupported dependencies and unprotected operations
can leave a Bot readable but unable to resume automatically. Supporting them
requires their resource closure or original-operation reconciliation, not clearing
dirty. Same-disk recovery does not cover machine or disk loss.
