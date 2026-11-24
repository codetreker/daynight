# Agent Note: Preserve stopped source event representations

Status: implemented

## Problem

A server can commit an online source event while its acknowledgement is lost.
Stopped replay must reconcile that event before publishing the archive. Rebuilding
the event changes JSON field order, while the server's retained digest identifies
the original encoded payload. A semantically equal replay can therefore conflict
and leave the archive unfinished. A previously persisted stopped batch may itself
have committed, so replacing its bytes under the same identity is unsafe.

## Decision

Stopped replay validates and retains the actual online representation. A legacy
pending batch is first reconciled unchanged. Only a definite conflict and local
proof of the original event representation permit a separate recovery request.
The server checks each retained event digest and commits its recovery receipt and
checkpoint under the existing stopped-writer admission and Session transaction.
The Controller persists bounded recovery segments before sending and settles only
the verified prefix under its original storage permit. The
[archive design](../../../../docs/design/session-image-archives.md#停止后的连续source尾部协调)
owns the protocol, limits, and failure conditions.

## Alternatives

**Rewrite the old batch under its existing ID.** The original request may already
have committed; changing its content would violate immutable batch identity and
make an unknown response impossible to reconcile.

**Treat a conflict or missing batch record as proof of noncommit.** The same
conflict covers several identity and content failures, and batch hashes have a
finite retention window. Neither observation proves which event was committed.

## Consequences

Recovery retains durable receipts and requires bounded storage in addition to the
existing finite event digest window. Missing proof, expired digests, unsupported
servers, or exhausted recovery capacity leave the original source available and
fail explicitly. The protocol does not establish that an arbitrary reported old
batch existed; that binding depends on the original Controller's local evidence.
