# Agent Note: Streaming Stopped Archive Uploads

Status: implemented

## Problem

Long stopped archives need resumable transfer without per-block requests and
database progress updates. A client cannot infer whether a disconnected write
or completion committed, and a restored volume can contain an earlier prefix
than the last offset it observed. A lease does not prove that a previous file
system call has exited.

## Decision

The stopped writer negotiates version 2 separately from online mode. Each file
uses one raw staging object under the [single-file staging contract](2026-11-23-archive-single-file-staging.md).
The Server accepts the remaining bytes in a bounded stream and observes progress
from storage. PostgreSQL retains the immutable identity, business transitions,
successor and terminal receipt. An explicit completion validates the full
digest and the purpose-specific archive rules before publishing the protected
bytes. A confirmed corrupt staging object can be replaced under the same writer
and closure; old receipts remain available. Network reads follow the media I/O
context so cancellation drains the writer before releasing storage protection.

Version 1 and online history retain their existing contracts. The
[archive design](../../../../docs/design/session-image-archives.md) owns the
protocol and storage boundaries.

## Alternatives

**Numbered blocks with database progress.** Each acknowledged block requires a
request and a database progress update, preserving costs proportional to the
archive size.

**Use a lease as the only exclusion.** Expiry cannot stop an already running
storage operation, so a replacement writer or cleanup could race it.

## Consequences

An interrupted stream resumes from the paired storage's observed offset,
including an earlier restored prefix. Full-file hashing detects corruption
before publication; partial prefixes have no independent checksum. Enabling
new uploads on local storage requires verified volume semantics; the [Azure
backend](2026-11-23-azure-archive-backend.md) uses Blob-specific exclusion and
offsets. Completion and cleanup
are separate, so a cleanup failure does not invalidate a durable receipt.
