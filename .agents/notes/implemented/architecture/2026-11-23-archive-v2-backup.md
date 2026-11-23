# Agent Note: Verify Numbered Archive Blocks in Paired Backups

Status: implemented

## Problem

A resumable archive needs a recoverable, verifiable confirmed prefix without a
PostgreSQL row for every transferred block. A stopped database and volume can
also contain a durable block whose acknowledgement was never committed; treating
that object as confirmed would invent progress after restoration.

## Decision

The original file row recorded the transport version, accepted offset, prefix
proof, successor and terminal error. Existing rows remained version 1. The
backup reader supported version 2 numbered immutable blocks and verified only
the confirmed prefix; the public uploader still wrote version 1. The shared
archive namespace owned block addresses and the proof algorithm.

The [single-file staging decision](2026-11-23-archive-single-file-staging.md)
replaces that version 2 representation. A forward migration refuses databases
containing numbered version 2 rows; historical backups need the matching reader.

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

The numbered format detected missing or altered confirmed bytes without scanning
arbitrary directory contents. Proof verification read the entire confirmed
prefix and required the matching stopped database and storage volume. It did not
expose a version 2 upload protocol.
