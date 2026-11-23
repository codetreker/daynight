# Agent Note: Linux owned command pre-dispatch closure

Status: implemented

## Problem

A Linux owned command can time out while independently capturing the launcher's
birth proof. The launcher itself previously spawned identity helpers before
receiving a command, so its direct exit could not prove their closure. A missing
proof retained unknown responsibility and blocked a replacement scope, even when
the command was never sent.

## Decision

The Linux launcher reads its own kernel birth and group identity without spawning
children before `run`. Its parent independently captures the canonical proof and
persists it before dispatch. The original owner can establish closure without a
proof only when it never attempted the send, the original child closed, and its
messages and output joined. Send attempts invalidate this qualification before
calling IPC. Sealed late handshakes cannot save a new birth or dispatch. Failed
terminal persistence retains the original owner's evidence for reconciliation;
historical null-proof records do not acquire that evidence after restart.

This narrows the pre-dispatch rule in the [execution scope decision](../architecture/2026-11-20-worker-execution-scopes.md).
The [Worker design](../../../../docs/design/daynight-worker.md#管理根与执行作用域)
describes the complete lifecycle.

## Alternatives

**Treat any direct-child exit as closure.** The previous launcher could spawn
proof helpers, and a dispatched command can leave descendants. Neither case is
proved closed by its direct child exiting.

**Continue requiring a full proof before cleanup.** A slow identity observation
can exhaust the budget before the proof exists, leaving a known unsubmitted
Linux launch permanently blocking recovery.

## Consequences

The original process can settle a known unsubmitted launch without weakening
post-dispatch group ownership. Pending messages, output or writes still retain
responsibility. macOS and Windows keep their existing evidence rules; a lost
original owner cannot reconstruct the new in-process closure evidence.
