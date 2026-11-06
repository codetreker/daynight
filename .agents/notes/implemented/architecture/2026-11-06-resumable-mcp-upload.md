# Agent Note: Resumable MCP Attachment Uploads

Status: implemented

## Problem

An MCP client needs to transfer an allowed attachment without placing its whole
contents in one request. A lost response must not make the client repeat an
unknown target write, and a process failure must not leave private chunks
without an owner and capacity accounting. A long upload should not hold a
business database transaction for its entire stream.

## Decision

The caller supplies a transfer ID. The private lifecycle binds it to the user,
stable authority and target before any private content is written. Each
external request revalidates the current credential and task permission. Chunk
receipts are indexed by stable chunk identity and offset; publication, receipt
and capacity accounting retain their respective failure facts. A single fenced
commit operation verifies the byte count and hash, then streams immutable chunks
through an admitted attachment use case. Private capacity and a namespace gate
protect temporary objects, and a target gate serializes publication with other
attachment operations. Target file and metadata remain separate side effects.

The original design admitted a commit without holding a business transaction
for its stream and allowed that operation to finish after Task deletion. This
avoided long-lived database locks, at the cost of allowing a retained attachment
to change after deletion. The [upload deletion barrier](2026-11-06-upload-deletion-barrier.md)
replaces that lifecycle ordering while retaining admitted identity behavior.
The [private transfer lifecycle](2026-11-06-private-transfer-lifecycle.md) and
[attachment design](../../../../docs/design/daynight-task-attachments.md)
own cleanup, capacity and current transport details.

## Alternatives

**Hold the Task row lock during the entire stream.** This preserves the ordinary
mutation ordering, but a long file monopolizes a database transaction and does
not satisfy the upload streaming requirement.

**Serialize Task deletion with a separate cross-process gate.** This adds a gate
to every deletion and introduces deployment coordination for mixed versions.
The original admission rule allowed a deleted task's already admitted upload to
finish without that shared lock.

## Consequences

A client can reconcile an accepted transfer and its original operation without
replaying an unknown commit. Cleanup waits for private I/O to quiesce and cannot
remove the target attachment. Removed access prevents later status reads even
when an already admitted operation finishes. A later deletion barrier serializes the final publication with Task and Project
deletion. Cross-store failures still may leave content
and metadata inconsistent.
