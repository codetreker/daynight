# Agent Note: Numbered Archive Blocks and Paired Backups

Status: implemented

## Problem

A resumable archive needs a recoverable, verifiable confirmed prefix without a
PostgreSQL row for every transferred block. A stopped database and volume can
also contain a durable block whose acknowledgement was never committed; treating
that object as confirmed would invent progress after restoration.

## Decision

The file row records the transport version, accepted offset, prefix proof,
successor and terminal error. Existing rows remain version 1. The version 2
uploader publishes fixed numbered blocks without overwriting existing objects and
advances the proof and offset together. Its explicit completion verifies the
confirmed prefix and full file before publication. A corrupt staging prefix
terminates only that file; an authorized restart preserves its receipt and
registers a successor under the same frozen source and archive closure. The
backup reader verifies only the confirmed prefix. The shared archive namespace
owns block addresses and the proof algorithm. The
[archive design](../../../../docs/design/session-image-archives.md#编号块上传与配对备份)
records the exact bytes, inventory and recovery contract.

Completed data follows its existing durable object or ledger and closure rules;
failed or retired staging is not needed for recovery. Terminal cleanup is
separate from the receipt; directory barriers precede the released marker,
and a failure retains its retry responsibility without blocking other files. A schema-matched reader is required for either generation of paired
backup. The backup reader preceded the version 2 writer so it could understand
the format before any public writer produced it. This extends the
[archive namespace decision](2026-11-05-session-archive-layout.md) and its
ownership and stopped-writer boundaries.

## Alternatives

**Keep per-block database rows.** This preserves the old recovery inventory but
continues database work proportional to the number of blocks.

**Use one mutable staging file.** Recovery would additionally need safe append,
truncation and verification of any unacknowledged tail. Numbered blocks retain
the existing object and cleanup model with a bounded proof in PostgreSQL.

## Consequences

Restoration detects missing or altered confirmed bytes without scanning arbitrary
directory contents. Proof verification reads the entire confirmed prefix, and
requires the matching stopped database and storage volume. Version 1 remains
available for existing clients and uploads. The schema migration requires old
writers to stop; rollback needs a binary that understands the current schema
and persisted uploads, or a matching pre-upgrade database and volume pair.
