# Agent Note: Single-file Archive Staging

Status: implemented

## Problem

The numbered archive format requires a database progress update for every
confirmed block. Long final archives need resumable transfer without per-block
database work, while a restored database and volume can reflect an earlier
point than the sender's last observation. A lease alone cannot prevent an old
filesystem call from continuing after the lease expires.

## Decision

Version 2 uses one raw staging file per file ID. Its durable length determines
the recoverable offset, rounded down to 512 KiB unless it is the declared full
length. PostgreSQL retains the immutable identity, business state, successor and
terminal receipt. The stopped-writer backup verifier observes the paired volume,
checks full-length data against its SHA-256, and verifies published closure.

An exclusive lock on the actual Session directory protects staging I/O and
namespace removal across processes. Archive-root coordination protects creation,
directory identity and removal. A durable file and directory barrier precedes
acknowledgement; incomplete tails are discarded on the next append. The
[streaming upload decision](2026-11-23-archive-streaming-upload.md) applies
this storage contract to the public stopped-archive protocol.
The [archive design](../../../../docs/design/session-image-archives.md#单文件暂存与配对备份读取)
owns the storage and verification contract.

The migration refuses any numbered version 2 row before removing its proof.
Version 1 rows remain valid; older paired backups use their matching schema and
verifier. This replaces the [numbered-block decision](2026-11-23-archive-v2-backup.md).

## Alternatives

**Keep numbered blocks and a PostgreSQL prefix proof.** This detects corruption
in the confirmed prefix, but updating that proof per block retains database work
proportional to archive length.

**Trust the Redis permit alone.** A lost lease revokes admission but cannot stop
an already executing filesystem call. A subsequent writer or cleanup could race
that call without a physical storage lock.

## Consequences

Recovery can resume from an earlier paired volume offset and retransmit bytes.
Partial prefixes have no independent proof; equal-length corruption is detected
by the full-file digest before publication. Shared volumes require demonstrated
cross-process locking, visibility and sync semantics before new writes are
enabled. The [Azure archive backend](2026-11-23-azure-archive-backend.md) uses
conditional creation and expected-offset append for object storage.
