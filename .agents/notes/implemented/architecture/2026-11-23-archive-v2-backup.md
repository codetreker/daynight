# Agent Note: Verify Numbered Archive Blocks in Paired Backups

Status: implemented

## Problem

A resumable archive needs a recoverable, verifiable confirmed prefix without a
PostgreSQL row for every transferred block. A stopped database and volume can
also contain a durable block whose acknowledgement was never committed; treating
that object as confirmed would invent progress after restoration.

## Decision

The file row records the transport version, accepted offset, prefix proof,
successor and terminal error. Existing rows remain version 1. The backup reader
supports version 2 numbered immutable blocks and verifies only the confirmed
prefix; the public uploader still writes version 1. The shared archive namespace
owns block addresses and the proof algorithm. The
[archive design](../../../../docs/design/session-image-archives.md#编号块的配对备份读取)
records the exact bytes, inventory and recovery contract.

Completed data follows its existing durable object or ledger and closure rules;
failed or retired staging is not needed for recovery. A schema-matched reader is
required for either generation of paired backup. This extends the
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
requires the matching stopped database and storage volume. The format is ready
for a later writer; this delivery does not expose a version 2 upload protocol.
